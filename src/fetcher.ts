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

export type FetchResult =
  | { ok: true; jobs: JobItem[] }
  | { ok: false; expired: true; message: string }
  | { ok: false; expired: false; error: string };

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
      return { ok: false, expired: false, error: `代理连接失败 (${proxy}): ${String(err)}` };
    }
  }

  let status: number;
  let body: string;
  try {
    const resp = await httpsRequest(url, headers, agent, 15_000);
    status = resp.status;
    body = resp.body;
  } catch (err) {
    return { ok: false, expired: false, error: `网络错误: ${String(err)}` };
  }

  if (status < 200 || status >= 300) {
    return { ok: false, expired: false, error: `HTTP ${status}` };
  }

  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    return { ok: false, expired: false, error: "响应解析失败" };
  }

  if (data?.code === 37 || data?.code === "37") {
    const msg = data?.message ?? "";
    // 区分"环境异常"（IP被封）和"Cookie过期"
    if (msg.includes("环境") || msg.includes("异常")) {
      return {
        ok: false,
        expired: true,
        message:
          "⚠️ Boss直聘检测到环境异常（通常是服务器 IP 被识别为非正常浏览器环境）。" +
          (proxy ? "当前代理可能也被封，请尝试更换代理。" : "请配置国内代理后重试。"),
      };
    }
    return { ok: false, expired: true, message: "⚠️ Boss直聘 Cookie 已失效，请重新上传。" };
  }

  if (data?.code !== 0) {
    return { ok: false, expired: false, error: `API错误 code=${data?.code}: ${data?.message ?? ""}` };
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
