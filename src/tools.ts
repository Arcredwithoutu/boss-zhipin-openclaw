// src/tools.ts
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, imageResultFromFile, readStringParam, readNumberParam } from "openclaw/plugin-sdk";

function readStringArrayParam(p: Record<string, unknown>, key: string): string[] | undefined {
  const val = p[key];
  if (val === undefined || val === null) return undefined;
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === "string");
  if (typeof val === "string") return [val];
  return undefined;
}
import { readState, updateState } from "./storage.js";
import { fetchJobs, type FailReason } from "./fetcher.js";
import { filterByConditions, deduplicateJobs } from "./filter.js";
import { formatJobList, formatStatusReport } from "./formatter.js";
import type { Filters } from "./types.js";

// ─── boss_update_cookie ────────────────────────────────────────────────────

export const bossUpdateCookieTool: AnyAgentTool = {
  name: "boss_update_cookie",
  label: "Update Boss直聘 Cookie",
  description:
    "更新 Boss直聘登录 Cookie。用户在 IM 中提供 cookie 字符串后调用此工具保存。Cookie 通常以 'wt2=' 或 'bst=' 开头。",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["cookie"],
    properties: {
      cookie: {
        type: "string",
        description: "从浏览器开发者工具 Network 面板中复制的完整 Cookie 请求头值",
        minLength: 10,
      },
    },
  } as any,
  async execute(_id, params) {
    const cookie = readStringParam(params as any, "cookie", { required: true });
    await updateState({
      cookie,
      cookieUpdatedAt: new Date().toISOString(),
      cookieExpired: false,
    });
    return jsonResult({ ok: true, message: "Cookie 已更新并保存。" });
  },
};

// ─── boss_set_filters ──────────────────────────────────────────────────────

export const bossSetFiltersTool: AnyAgentTool = {
  name: "boss_set_filters",
  label: "Set Boss直聘 job filters",
  description:
    "设置 Boss直聘岗位筛选条件。可部分更新，未传的字段保持不变。cities 传城市名（如 北京、上海），salary 传千元整数，publishedWithin 传如 '3h' 或 '24h'。",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      cities: {
        type: "array",
        items: { type: "string" },
        description: "城市名列表，如 [\"北京\", \"上海\"]",
      },
      salaryMin: {
        type: "number",
        description: "最低薪资（千元），如 15 表示 15k",
      },
      salaryMax: {
        type: "number",
        description: "最高薪资（千元），如 35 表示 35k",
      },
      keywords: {
        type: "array",
        items: { type: "string" },
        description: "岗位关键词列表，如 [\"前端\", \"React\"]",
      },
      publishedWithin: {
        type: "string",
        description: "发布时间范围，如 '3h'、'24h'、'7d'",
      },
    },
  } as any,
  async execute(_id, params) {
    const p = params as Record<string, unknown>;
    const current = await readState();
    const currentFilters: Filters = current.filters ?? {};

    const cities = readStringArrayParam(p, "cities");
    const salaryMin = readNumberParam(p, "salaryMin");
    const salaryMax = readNumberParam(p, "salaryMax");
    const keywords = readStringArrayParam(p, "keywords");
    const publishedWithin = readStringParam(p, "publishedWithin");

    const newFilters: Filters = {
      ...currentFilters,
      ...(cities !== undefined ? { cities } : {}),
      ...(keywords !== undefined ? { keywords } : {}),
      ...(publishedWithin !== undefined ? { publishedWithin } : {}),
      salary: {
        ...currentFilters.salary,
        ...(salaryMin !== undefined ? { min: salaryMin } : {}),
        ...(salaryMax !== undefined ? { max: salaryMax } : {}),
      },
    };

    await updateState({ filters: newFilters });
    return jsonResult({ ok: true, filters: newFilters, message: "筛选条件已更新。" });
  },
};

// ─── boss_fetch_jobs ───────────────────────────────────────────────────────

export const bossFetchJobsTool: AnyAgentTool = {
  name: "boss_fetch_jobs",
  label: "Fetch Boss直聘 jobs",
  description:
    "拉取 Boss直聘 岗位列表。定时 cron 任务和用户主动请求都调用此工具。返回格式化的岗位 Markdown 列表。如果 cookie 失效会返回错误提示。",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: {
        type: "number",
        description: "最多返回岗位数量，默认 20",
        minimum: 1,
        maximum: 100,
      },
      publishedWithin: {
        type: "string",
        description: "覆盖发布时间筛选，如 '3h'。不传则使用已保存的筛选条件",
      },
      deduplicate: {
        type: "boolean",
        description: "是否过滤已推送过的岗位，默认 true（定时推送时应为 true，主动拉取时可为 false）",
      },
    },
  } as any,
  async execute(_id, params) {
    const p = params as Record<string, unknown>;
    const limit = readNumberParam(p, "limit") ?? 20;
    const publishedWithinOverride = readStringParam(p, "publishedWithin");
    const deduplicate = typeof p.deduplicate === "boolean" ? p.deduplicate : true;

    const state = await readState();

    if (!state.cookie) {
      return jsonResult({
        ok: false,
        expired: false,
        message: "❌ 尚未配置 Boss直聘 Cookie。请通过 IM 发送您的 Cookie，然后我会调用 boss_update_cookie 保存。",
      });
    }

    const filters: Filters = {
      ...state.filters,
      ...(publishedWithinOverride ? { publishedWithin: publishedWithinOverride } : {}),
    };

    const result = await fetchJobs({
      cookie: state.cookie,
      filters,
      pageSize: Math.min(limit, 20),
      proxy: state.proxy,
    });

    if (!result.ok) {
      if (result.reason === "cookie_expired") {
        await updateState({ cookieExpired: true });
      }
      return jsonResult({
        ok: false,
        reason: result.reason,
        message: result.message,
        ...(result.rawCode !== undefined ? { rawCode: result.rawCode } : {}),
        ...(result.rawMessage ? { rawMessage: result.rawMessage } : {}),
      });
    }

    let jobs = result.jobs.slice(0, limit);

    // 条件过滤（薪资等在API层无法精确控制）
    jobs = filterByConditions(jobs, filters);

    // 去重
    if (deduplicate) {
      jobs = await deduplicateJobs(jobs);
    }

    const formatted = formatJobList(jobs);
    return jsonResult({ ok: true, count: jobs.length, formatted });
  },
};

// ─── boss_get_status ───────────────────────────────────────────────────────

export const bossGetStatusTool: AnyAgentTool = {
  name: "boss_get_status",
  label: "Get Boss直聘 plugin status",
  description: "查看 Boss直聘插件当前配置状态，包括 Cookie 有效性和筛选条件。",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {},
  } as any,
  async execute(_id, _params) {
    const state = await readState();
    const report = formatStatusReport({
      cookie: state.cookie,
      cookieExpired: state.cookieExpired,
      cookieUpdatedAt: state.cookieUpdatedAt,
      filters: state.filters as any,
      proxy: state.proxy,
    });
    return jsonResult({ ok: true, report });
  },
};

// ─── boss_set_proxy ──────────────────────────────────────────────────────

export const bossSetProxyTool: AnyAgentTool = {
  name: "boss_set_proxy",
  label: "Set Boss直聘 proxy",
  description:
    "设置请求 Boss直聘 API 时使用的代理地址。支持 socks5:// 和 http:// 协议。如果服务器在境外，需要通过国内代理才能正常访问 Boss直聘。传空字符串可清除代理。",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["proxy"],
    properties: {
      proxy: {
        type: "string",
        description: "代理地址，如 socks5://127.0.0.1:1080 或 http://127.0.0.1:8080，传空字符串清除",
      },
    },
  } as any,
  async execute(_id, params) {
    const proxy = readStringParam(params as any, "proxy", { required: true });
    if (proxy === "") {
      await updateState({ proxy: undefined });
      return jsonResult({ ok: true, message: "代理已清除，将直连请求。" });
    }
    if (!/^(socks[45]?|https?):\/\/.+/.test(proxy)) {
      return jsonResult({ ok: false, message: "代理格式无效，请使用 socks5://host:port 或 http://host:port" });
    }
    await updateState({ proxy });
    return jsonResult({ ok: true, message: `代理已设置为 ${proxy}` });
  },
};

// ─── boss_browser_login ──────────────────────────────────────────────────

export const bossBrowserLoginTool: AnyAgentTool = {
  name: "boss_browser_login",
  label: "Boss直聘 browser login",
  description:
    "通过微信扫码登录 Boss直聘。获取微信小程序码图片供用户扫码，扫码后自动完成登录并保存 Cookie。" +
    "调用 action=start 发起登录并获取二维码图片，调用 action=check 检查登录是否完成。",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["start", "check"],
        description: "start=发起登录并获取微信小程序码，check=检查登录是否完成",
      },
    },
    required: ["action"],
  } as any,
  async execute(_id, params) {
    const action = readStringParam(params as any, "action", { required: true });
    const { startLogin, pollLogin } = await import("./login.js");
    const state = await readState();

    if (action === "start") {
      const result = await startLogin(state.proxy);
      if (result.ok) {
        // 保存 session 到全局，供 check 使用
        (globalThis as any).__boss_login_session = result.session;

        // 启动后台轮询（最多 2 分钟）
        pollLogin(result.session, state.proxy, 120_000).then(async (loginResult) => {
          if (loginResult.ok) {
            await updateState({
              cookie: loginResult.cookieString,
              cookieUpdatedAt: new Date().toISOString(),
              cookieExpired: false,
            });
          }
          (globalThis as any).__boss_login_session = undefined;
          (globalThis as any).__boss_login_result = loginResult;
        });

        return imageResultFromFile({
          label: "Boss直聘登录二维码",
          path: result.qrPath,
          extraText: "📸 请使用微信扫描上方小程序码登录 Boss直聘。扫码后等待约 5 秒，然后调用 boss_browser_login(action=\"check\") 确认登录状态。",
        });
      }
      return jsonResult({ ok: false, message: result.message });
    }

    if (action === "check") {
      // 检查后台轮询的结果
      const loginResult = (globalThis as any).__boss_login_result;
      if (loginResult?.ok) {
        (globalThis as any).__boss_login_result = undefined;
        return jsonResult({ ok: true, message: "✅ 登录成功，Cookie 已保存并同步。" });
      }

      if (loginResult && !loginResult.ok) {
        (globalThis as any).__boss_login_result = undefined;
        return jsonResult({ ok: false, message: loginResult.message });
      }

      const session = (globalThis as any).__boss_login_session;
      if (session) {
        return jsonResult({ ok: false, message: "⏳ 登录仍在进行中，请扫码后再次 check。" });
      }
      return jsonResult({ ok: false, message: "❌ 没有进行中的登录会话。请先调用 action=start。" });
    }

    return jsonResult({ ok: false, message: `未知 action: ${action}` });
  },
};

// ─── boss_browser_fetch ─────────────────────────────────────────────────

export const bossBrowserFetchTool: AnyAgentTool = {
  name: "boss_browser_fetch",
  label: "Fetch jobs via browser",
  description:
    "使用 Puppeteer 浏览器拉取 Boss直聘 岗位。浏览器会自动刷新 __zp_stoken__，无需手动更新 Cookie。" +
    "优先用浏览器刷新 token 后走 HTTP API（更快），备选全浏览器拉取。" +
    "需要 state 中有基础 Cookie（wt2/zp_at/bst）。适用于定时推送。",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: {
        type: "number",
        description: "最多返回岗位数量，默认 20",
      },
      deduplicate: {
        type: "boolean",
        description: "是否过滤已推送过的岗位，默认 true",
      },
    },
  } as any,
  async execute(_id, params) {
    const p = params as Record<string, unknown>;
    const limit = readNumberParam(p, "limit") ?? 20;
    const deduplicate = typeof p.deduplicate === "boolean" ? p.deduplicate : true;

    const state = await readState();
    if (!state.cookie) {
      return jsonResult({
        ok: false,
        message: "❌ 没有 Cookie，请先通过 boss_update_cookie 或 boss_browser_login 提供。",
      });
    }

    // 步骤1：用浏览器刷新 __zp_stoken__
    const { refreshToken } = await import("./browser.js");
    const tokenResult = await refreshToken({
      cookieString: state.cookie,
      proxy: state.proxy,
    });

    if (!tokenResult.ok) {
      // Token 刷新失败 — 根据原因决定处理策略
      if (tokenResult.reason === "about_blank_loop" || tokenResult.reason === "browser_error") {
        // IP 严格封禁或浏览器异常 — 自动触发扫码登录
        const { startLogin: startHttpLogin, pollLogin } = await import("./login.js");
        const loginResult = await startHttpLogin(state.proxy);
        if (loginResult.ok) {
          pollLogin(loginResult.session, state.proxy, 120_000).then(async (lr) => {
            if (lr.ok) {
              await updateState({
                cookie: lr.cookieString,
                cookieUpdatedAt: new Date().toISOString(),
                cookieExpired: false,
              });
            }
          });
          return imageResultFromFile({
            label: "Boss直聘登录二维码",
            path: loginResult.qrPath,
            extraText: `⚠️ stoken 刷新失败（${tokenResult.reason}: ${tokenResult.error}）。请用微信扫码重新登录，登录后再次拉取岗位。`,
          });
        }
      }
      return jsonResult({
        ok: false,
        reason: tokenResult.reason,
        message: `stoken 刷新失败：${tokenResult.error}`,
      });
    }

    // 步骤2：用刷新后的 Cookie 走 HTTP API（更快、更轻量）
    const filters: Filters = state.filters ?? {};
    const result = await fetchJobs({
      cookie: tokenResult.cookieString,
      filters,
      pageSize: Math.min(limit, 20),
      proxy: state.proxy,
    });

    // 同步最新 cookie
    await updateState({
      cookie: tokenResult.cookieString,
      cookieUpdatedAt: new Date().toISOString(),
      cookieExpired: false,
    });

    if (!result.ok) {
      if (result.reason === "cookie_expired") {
        await updateState({ cookieExpired: true });
      }
      return jsonResult({
        ok: false,
        reason: result.reason,
        message: result.message,
        ...(result.rawCode !== undefined ? { rawCode: result.rawCode } : {}),
        ...(result.rawMessage ? { rawMessage: result.rawMessage } : {}),
      });
    }

    let jobs = result.jobs.slice(0, limit);
    jobs = filterByConditions(jobs, filters);
    if (deduplicate) {
      jobs = await deduplicateJobs(jobs);
    }

    const formatted = formatJobList(jobs);
    return jsonResult({ ok: true, count: jobs.length, formatted });
  },
};

export const ALL_TOOLS: AnyAgentTool[] = [
  bossUpdateCookieTool,
  bossSetFiltersTool,
  bossFetchJobsTool,
  bossGetStatusTool,
  bossSetProxyTool,
  bossBrowserLoginTool,
  bossBrowserFetchTool,
];
