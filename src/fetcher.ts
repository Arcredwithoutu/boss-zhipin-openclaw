// src/fetcher.ts
import type { JobItem, Filters } from "./types.js";
import https from "node:https";
import { URL } from "node:url";

const BASE_URL = "https://www.zhipin.com";
const JOB_LIST_PATH = "/wapi/zpgeek/search/joblist.json";

// 城市名 → 城市代码 映射（常用城市）
const CITY_CODE_MAP: Record<string, string> = {
  "北京": "101010100",
  "上海": "101020100",
  "广州": "101280100",
  "深圳": "101280600",
  "杭州": "101210100",
  "成都": "101270100",
  "武汉": "101200100",
  "南京": "101190100",
  "西安": "101110100",
  "重庆": "101040100",
  "天津": "101030100",
  "苏州": "101190400",
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * 错误原因分类，便于 AI agent 精准诊断和处理：
 *
 * - stoken_expired:   __zp_stoken__ 过期（~5分钟有效），需要通过 Puppeteer 刷新
 * - cookie_expired:   wt2/zp_at/bst 认证 Cookie 过期，需要重新扫码登录
 * - ip_blocked:       服务器 IP 被 Boss直聘 识别为异常环境，需要配置/更换代理
 * - env_abnormal:     环境异常（通用），可能是 IP 或 stoken 问题
 * - rate_limited:     请求频率过高被限流，需要等待冷却
 * - network_error:    网络连接错误（代理不通、DNS 解析失败等）
 * - api_error:        其他 API 错误（非 code=37）
 * - parse_error:      响应解析失败（非 JSON）
 * - http_error:       HTTP 状态码异常（非 2xx）
 */
export type FailReason =
  | "stoken_expired"
  | "cookie_expired"
  | "ip_blocked"
  | "env_abnormal"
  | "rate_limited"
  | "network_error"
  | "api_error"
  | "parse_error"
  | "http_error";

export type FetchResult =
  | { ok: true; jobs: JobItem[] }
  | { ok: false; reason: FailReason; message: string; rawCode?: number; rawMessage?: string };

export type FetchOptions = {
  cookie: string;
  filters: Filters;
  pageSize?: number;
  page?: number;
  proxy?: string; // e.g. "socks5://127.0.0.1:1080" or "http://127.0.0.1:8080"
};

async function createProxyAgent(proxyUrl: string): Promise<https.Agent> {
  if (proxyUrl.startsWith("socks")) {
    const { SocksProxyAgent } = await import("socks-proxy-agent");
    return new SocksProxyAgent(proxyUrl);
  }
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  return new HttpsProxyAgent(proxyUrl);
}

/**
 * 使用 node:https 发起请求（支持代理 agent）
 */
function httpsRequest(
  url: string,
  headers: Record<string, string>,
  agent?: https.Agent,
  timeoutMs = 15_000,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers,
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("请求超时"));
    });
    req.end();
  });
}

function resolveCityCodes(cities: string[]): string[] {
  return cities.map((c) => CITY_CODE_MAP[c] ?? c);
}

function buildQueryParams(filters: Filters, page: number, pageSize: number): URLSearchParams {
  const params = new URLSearchParams({
    scene: "1",
    page: String(page),
    pageSize: String(pageSize),
  });

  if (filters.keywords?.length) {
    params.set("query", filters.keywords.join(" "));
  }

  const codes = filters.cityCodes ?? (filters.cities ? resolveCityCodes(filters.cities) : []);
  if (codes.length > 0) {
    params.set("city", codes[0]!);
  }

  return params;
}

async function fetchOnePage(opts: FetchOptions & { page: number }): Promise<FetchResult> {
  const { cookie, filters, pageSize = 20, page, proxy } = opts;
  const params = buildQueryParams(filters, page, pageSize);
  const url = `${BASE_URL}${JOB_LIST_PATH}?${params.toString()}`;

  const headers: Record<string, string> = {
    "Cookie": cookie,
    "User-Agent": USER_AGENT,
    "Referer": "https://www.zhipin.com/web/geek/job",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };

  let agent: https.Agent | undefined;
  if (proxy) {
    try {
      agent = await createProxyAgent(proxy);
    } catch (err) {
      return { ok: false, reason: "network_error", message: `代理连接失败 (${proxy}): ${String(err)}` };
    }
  }

  let status: number;
  let body: string;
  try {
    const resp = await httpsRequest(url, headers, agent, 15_000);
    status = resp.status;
    body = resp.body;
  } catch (err) {
    return { ok: false, reason: "network_error", message: `网络错误: ${String(err)}` };
  }

  if (status < 200 || status >= 300) {
    return { ok: false, reason: "http_error", message: `HTTP ${status}` };
  }

  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    return { ok: false, reason: "parse_error", message: "响应解析失败（非 JSON）" };
  }

  if (data?.code === 37 || data?.code === "37") {
    const msg: string = data?.message ?? "";
    const raw = { rawCode: 37, rawMessage: msg };

    // 细粒度分类 code=37 的具体场景
    if (msg.includes("环境") || msg.includes("异常")) {
      // "您的环境存在异常" — 通常是 stoken 过期或 IP 问题
      // 进一步区分：检查是否有 __zp_stoken__
      const hasStoken = cookie.includes("__zp_stoken__=");

      if (!hasStoken) {
        // 没有 stoken，大概率是 stoken 缺失导致
        return {
          ok: false, reason: "stoken_expired", ...raw,
          message: "🔑 __zp_stoken__ 缺失，需要通过浏览器刷新安全令牌。建议使用 boss_browser_fetch 自动刷新。",
        };
      }

      // 有 stoken 但仍然环境异常 → 可能是 stoken 过期或 IP 被封
      if (proxy) {
        return {
          ok: false, reason: "ip_blocked", ...raw,
          message: "🚫 Boss直聘检测到环境异常。可能原因：(1) __zp_stoken__ 已过期（~5分钟有效），建议用 boss_browser_fetch 刷新；(2) 代理 IP 被封禁，尝试更换代理。",
        };
      }

      return {
        ok: false, reason: "ip_blocked", ...raw,
        message: "🚫 Boss直聘检测到环境异常，服务器 IP 被识别为非正常浏览器环境。请配置国内代理（boss_set_proxy）后重试。",
      };
    }

    if (msg.includes("登录") || msg.includes("login") || msg.includes("token")) {
      return {
        ok: false, reason: "cookie_expired", ...raw,
        message: "🔒 认证 Cookie 已失效（wt2/zp_at 过期），需要重新扫码登录（boss_browser_login）。",
      };
    }

    if (msg.includes("频繁") || msg.includes("频率") || msg.includes("限") || msg.includes("稍后")) {
      return {
        ok: false, reason: "rate_limited", ...raw,
        message: "⏳ 请求频率过高被限流，请等待 5-10 分钟后重试。",
      };
    }

    // 兜底：无法从 message 精确判断
    return {
      ok: false, reason: "env_abnormal", ...raw,
      message: `⚠️ Boss直聘返回 code=37: ${msg || "未知错误"}。可能原因：stoken 过期、IP 异常、Cookie 失效。建议先尝试 boss_browser_fetch（自动刷新 stoken），若仍失败则重新扫码登录。`,
    };
  }

  if (data?.code !== 0) {
    return {
      ok: false, reason: "api_error",
      rawCode: data?.code, rawMessage: data?.message ?? "",
      message: `API 错误 code=${data?.code}: ${data?.message ?? ""}`,
    };
  }

  const jobList: JobItem[] = (data?.zpData?.jobList ?? []).map((j: any): JobItem => ({
    encryptJobId: j.encryptJobId ?? "",
    jobName: j.jobName ?? "",
    brandName: j.brandName ?? "",
    brandScaleName: j.brandScaleName,
    brandIndustry: j.brandIndustry,
    cityName: j.cityName ?? "",
    areaDistrict: j.areaDistrict,
    salaryDesc: j.salaryDesc ?? "",
    jobLabels: Array.isArray(j.jobLabels) ? j.jobLabels : [],
    jobExperience: j.jobExperience,
    jobDegree: j.jobDegree,
    skills: Array.isArray(j.skills) ? j.skills : [],
    welfareList: Array.isArray(j.welfareList) ? j.welfareList : [],
    lastModifyTime: j.lastModifyTime,
  }));

  return { ok: true, jobs: jobList };
}

/**
 * 拉取岗位，支持多城市（依次请求每个城市）
 */
export async function fetchJobs(opts: FetchOptions): Promise<FetchResult> {
  const { filters } = opts;
  const cities = filters.cityCodes ?? (filters.cities ? resolveCityCodes(filters.cities) : [undefined]);

  const allJobs: JobItem[] = [];

  for (const cityCode of cities) {
    const filtersWithCity: Filters = {
      ...filters,
      cityCodes: cityCode ? [cityCode] : undefined,
    };
    const result = await fetchOnePage({ ...opts, filters: filtersWithCity, page: opts.page ?? 1, proxy: opts.proxy });

    if (!result.ok) {
      return result;
    }
    allJobs.push(...result.jobs);
  }

  return { ok: true, jobs: allJobs };
}

export function buildJobLink(encryptJobId: string): string {
  return `${BASE_URL}/job_detail/${encryptJobId}.html`;
}
