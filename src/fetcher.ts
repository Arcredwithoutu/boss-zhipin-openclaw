// src/fetcher.ts
import type { JobItem, Filters } from "./types.js";

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
  | { ok: false; expired: true }
  | { ok: false; expired: false; error: string };

export type FetchOptions = {
  cookie: string;
  filters: Filters;
  pageSize?: number;
  page?: number;
};

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
  const { cookie, filters, pageSize = 20, page } = opts;
  const params = buildQueryParams(filters, page, pageSize);
  const url = `${BASE_URL}${JOB_LIST_PATH}?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "Cookie": cookie,
        "User-Agent": USER_AGENT,
        "Referer": "https://www.zhipin.com/web/geek/job",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, expired: false, error: `网络错误: ${String(err)}` };
  }

  if (!res.ok) {
    return { ok: false, expired: false, error: `HTTP ${res.status}` };
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    return { ok: false, expired: false, error: "响应解析失败" };
  }

  if (data?.code === 37 || data?.code === "37") {
    return { ok: false, expired: true };
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
    const result = await fetchOnePage({ ...opts, filters: filtersWithCity, page: opts.page ?? 1 });

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
