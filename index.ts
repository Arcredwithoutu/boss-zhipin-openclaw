// index.ts
import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { ALL_TOOLS } from "./src/tools.js";
import { readState, updateState } from "./src/storage.js";

const CRON_JOB_NAME = "boss-zhipin-push";

type PluginConfig = {
  deliveryChannels?: string[];
  deliveryTarget?: {
    feishu?: string;
    wecom?: string;
    telegram?: string;
  };
  cronExpr?: string;
  cronTz?: string;
  proxy?: string;
};

async function ensureCronJob(
  ctx: OpenClawPluginServiceContext,
  pluginConfig: PluginConfig,
): Promise<void> {
  const { logger } = ctx;

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    // Check existing jobs
    const listResult = await execFileAsync("openclaw", ["cron", "list", "--json"], {
      timeout: 10_000,
    }).catch(() => ({ stdout: "[]" }));

    let jobs: any[] = [];
    try {
      const parsed = JSON.parse(listResult.stdout);
      jobs = Array.isArray(parsed) ? parsed : parsed?.jobs ?? [];
    } catch {}

    const existing = jobs.find((j: any) => j.name === CRON_JOB_NAME);
    if (existing) {
      logger.info(`[boss-zhipin] Cron job "${CRON_JOB_NAME}" already registered (id: ${existing.jobId ?? existing.id})`);
      return;
    }

    const cronExpr = pluginConfig.cronExpr ?? "0 */3 * * *";
    const tz = pluginConfig.cronTz ?? "Asia/Shanghai";

    // Determine delivery channel (first configured one)
    const channels = pluginConfig.deliveryChannels ?? ["feishu", "wecom", "telegram"];
    const targets = pluginConfig.deliveryTarget ?? {};

    let deliveryChannel: string | null = null;
    let deliveryTarget: string | null = null;

    for (const ch of channels) {
      const t = targets[ch as keyof typeof targets];
      if (t) {
        deliveryChannel = ch;
        deliveryTarget = t;
        break;
      }
    }

    const cronMessage =
      "你是 Boss直聘推送助手。请先调用 boss_browser_fetch 工具（参数：deduplicate=true），获取新岗位。" +
      "如果返回 ok=true 且 count>0，将 formatted 字段的内容直接作为你的回复输出。" +
      "如果 count=0，回复 'HEARTBEAT_OK 暂无新岗位'。" +
      "如果失败（expired=true 或 Token 刷新失败），工具会自动发送登录二维码图片，请提示用户扫码登录后重试。" +
      "如果 boss_browser_fetch 不可用，降级调用 boss_fetch_jobs（参数：deduplicate=true, publishedWithin='3h'）。";

    const addArgs = [
      "cron", "add",
      "--name", CRON_JOB_NAME,
      "--cron", cronExpr,
      "--tz", tz,
      "--session", "isolated",
      "--message", cronMessage,
    ];

    if (deliveryChannel && deliveryTarget) {
      addArgs.push("--announce", "--channel", deliveryChannel, "--to", deliveryTarget);
    } else {
      addArgs.push("--announce");
    }

    await execFileAsync("openclaw", addArgs, { timeout: 15_000 });
    logger.info(`[boss-zhipin] Cron job "${CRON_JOB_NAME}" registered (${cronExpr} ${tz})`);
  } catch (err) {
    logger.warn(`[boss-zhipin] Failed to register cron job: ${String(err)}`);
  }
}

const plugin = {
  id: "boss-zhipin",
  name: "Boss直聘推送",
  description: "Boss直聘岗位定时推送插件，支持飞书/企业微信/Telegram",

  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;

    // Register all agent tools
    for (const tool of ALL_TOOLS) {
      api.registerTool(tool);
    }

    // Register service to set up cron on gateway start
    api.registerService({
      id: "boss-zhipin-cron-setup",
      async start(ctx) {
        // Sync proxy from plugin config to state if not set via IM
        if (pluginConfig.proxy) {
          const state = await readState();
          if (!state.proxy) {
            await updateState({ proxy: pluginConfig.proxy });
            ctx.logger.info(`[boss-zhipin] Proxy initialized from config: ${pluginConfig.proxy}`);
          }
        }
        await ensureCronJob(ctx, pluginConfig);
      },
    });

    api.logger.info("[boss-zhipin] Plugin registered");
  },
};

export default plugin;
