// src/formatter.ts
import type { JobItem } from "./types.js";
import { buildJobLink } from "./fetcher.js";

function formatJob(job: JobItem): string {
  const location = [job.cityName, job.areaDistrict].filter(Boolean).join("-");
  const companyInfo = [job.brandName, job.brandIndustry, job.brandScaleName].filter(Boolean).join(" · ");
  const requirements = [job.jobExperience, job.jobDegree].filter(Boolean).join(" / ");
  const skillsStr = job.skills?.length ? job.skills.join(", ") : "";
  const link = buildJobLink(job.encryptJobId);

  return [
    `【${job.jobName}】 ${companyInfo}`,
    `📍 ${location}`,
    `💰 ${job.salaryDesc}`,
    requirements ? `📌 要求：${requirements}` : null,
    skillsStr ? `🏷️ 技能：${skillsStr}` : null,
    `🔗 ${link}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatJobList(jobs: JobItem[], fetchedAt: Date = new Date()): string {
  if (jobs.length === 0) {
    return "暂无新岗位。";
  }

  const timeStr = fetchedAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const header = `📋 Boss直聘 · ${jobs.length} 条新岗位（${timeStr}）`;
  const divider = "━━━━━━━━━━━━━━━━━";

  const body = jobs.map((j) => `${divider}\n${formatJob(j)}`).join("\n\n");

  return `${header}\n\n${body}`;
}

export function formatStatusReport(state: {
  cookie?: string;
  cookieExpired?: boolean;
  cookieUpdatedAt?: string;
  filters?: Record<string, unknown>;
  proxy?: string;
}): string {
  const lines: string[] = ["📊 Boss直聘插件状态\n"];

  if (!state.cookie) {
    lines.push("❌ Cookie：未配置");
  } else if (state.cookieExpired) {
    lines.push("⚠️ Cookie：已失效，请重新上传");
  } else {
    const updatedAt = state.cookieUpdatedAt
      ? new Date(state.cookieUpdatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
      : "未知";
    lines.push(`✅ Cookie：有效（更新于 ${updatedAt}）`);
  }

  if (state.proxy) {
    lines.push(`🌐 代理：${state.proxy}`);
  } else {
    lines.push("🌐 代理：未配置（直连）");
  }

  if (state.filters && Object.keys(state.filters).length > 0) {
    lines.push("\n筛选条件：");
    lines.push("```");
    lines.push(JSON.stringify(state.filters, null, 2));
    lines.push("```");
  } else {
    lines.push("\n筛选条件：未设置（将拉取默认结果）");
  }

  return lines.join("\n");
}
