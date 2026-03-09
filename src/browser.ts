// src/browser.ts
// Puppeteer-based browser module for Boss直聘
// Uses xvfb + stealth + headed mode to bypass verify-sdk detection
// Auto-refreshes __zp_stoken__ by letting the browser handle security verification

import { join } from "node:path";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import type { Browser, Page, Cookie } from "puppeteer-core";
import type { JobItem, Filters } from "./types.js";

const CHROMIUM_PATH = "/usr/bin/chromium-browser";
const STATE_DIR = join(homedir(), ".openclaw", "boss-zhipin");
const COOKIES_FILE = join(STATE_DIR, "browser-cookies.json");
const QR_SCREENSHOT = join(STATE_DIR, "qr-login.png");

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

function resolveCityCode(city: string): string {
  return CITY_CODE_MAP[city] ?? city;
}

function getCookiesPath(): string {
  return join(STATE_DIR, "browser-cookies.json");
}

function getQrScreenshotPath(): string {
  return join(STATE_DIR, "qr-login.png");
}

async function ensureStateDir(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
}

/**
 * 启动浏览器（xvfb headed 模式 + stealth）
 */
async function launchBrowser(proxy?: string): Promise<Browser> {
  const puppeteerExtra = await import("puppeteer-extra");
  const StealthPlugin = await import("puppeteer-extra-plugin-stealth");
  puppeteerExtra.default.use(StealthPlugin.default());

  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--window-size=1280,800",
  ];
  if (proxy) {
    args.push(`--proxy-server=${proxy}`);
  }

  // 确保 Xvfb 虚拟显示可用
  if (!process.env.DISPLAY) {
    // 检查 :99 是否已有 Xvfb 运行
    try {
      execSync("pgrep -f 'Xvfb :99'", { timeout: 2000 });
      process.env.DISPLAY = ":99";
    } catch {
      // 没有运行，启动一个
      try {
        execSync("Xvfb :99 -screen 0 1280x800x24 &", { timeout: 3000 });
        process.env.DISPLAY = ":99";
        await new Promise((r) => setTimeout(r, 500));
      } catch {
        // 最后兜底：尝试 :100
        try {
          execSync("Xvfb :100 -screen 0 1280x800x24 &", { timeout: 3000 });
          process.env.DISPLAY = ":100";
          await new Promise((r) => setTimeout(r, 500));
        } catch {
          // Xvfb 不可用，让 puppeteer 报错
        }
      }
    }
  }

  return puppeteerExtra.default.launch({
    executablePath: CHROMIUM_PATH,
    args,
    headless: false, // headed 模式避免 verify-sdk 检测
    defaultViewport: { width: 1280, height: 800 },
  });
}

/**
 * 保存浏览器 Cookie 到文件
 */
async function saveBrowserCookies(browser: Browser): Promise<Cookie[]> {
  await ensureStateDir();
  const cookies = await browser.cookies("https://www.zhipin.com");
  await writeFile(getCookiesPath(), JSON.stringify(cookies, null, 2));
  return cookies;
}

/**
 * 从文件加载 Cookie 到浏览器
 */
async function loadBrowserCookies(page: Page): Promise<boolean> {
  try {
    const raw = await readFile(getCookiesPath(), "utf8");
    const cookies: Cookie[] = JSON.parse(raw);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
      return true;
    }
  } catch {
    // no saved cookies
  }
  return false;
}

/**
 * 从 state.json 的 cookie 字符串注入到浏览器
 */
async function injectCookieString(page: Page, cookieStr: string, opts?: { stripStoken?: boolean }): Promise<void> {
  const cookies = cookieStr
    .split("; ")
    .filter((pair) => !(opts?.stripStoken && pair.startsWith("__zp_stoken__=")))
    .map((pair) => {
      const [name, ...rest] = pair.split("=");
      return { name: name.trim(), value: rest.join("="), domain: ".zhipin.com", path: "/" };
    });
  await page.setCookie(...cookies);
}

/**
 * Cookie 数组转为 HTTP Cookie 字符串
 */
function cookiesToString(cookies: Cookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// ────────────────────────────────────────────────────────────────────────────
// Token refresh: 通过浏览器自动刷新 __zp_stoken__
// ────────────────────────────────────────────────────────────────────────────

export type TokenRefreshResult =
  | { ok: true; cookieString: string; cookies: Cookie[] }
  | { ok: false; error: string };

/**
 * 使用 Puppeteer 刷新 __zp_stoken__
 *
 * 流程：
 * 1. 启动浏览器，注入已有 Cookie（去掉旧 stoken 避免触发更严格检测）
 * 2. 导航到搜索页 → about:blank 时自动重试
 * 3. 重试后触发 security.html 安全验证
 * 4. 验证通过后浏览器自动生成新 __zp_stoken__
 * 5. 提取并返回完整 Cookie
 */
export async function refreshToken(opts: {
  cookieString: string;
  proxy?: string;
  searchUrl?: string;
}): Promise<TokenRefreshResult> {
  let browser: Browser | undefined;
  try {
    browser = await launchBrowser(opts.proxy);
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );

    // 注入已有 Cookie，去掉旧 __zp_stoken__（旧值会触发 verify-sdk 更严格的检测）
    await injectCookieString(page, opts.cookieString, { stripStoken: true });

    const url = opts.searchUrl ?? "https://www.zhipin.com/web/geek/job?query=java&city=101020100";

    // 带延迟的 about:blank 重试策略
    // verify-sdk 检测到异常时跳转 about:blank，等待几秒再重试可降低限频风险
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [2000, 4000, 6000]; // 逐步增加延迟

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    let refreshed = false;
    let retries = 0;

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));

      const currentUrl = page.url();

      // 检测到 about:blank → 等待后重试导航
      if (currentUrl === "about:blank" && retries < MAX_RETRIES) {
        retries++;
        const delay = RETRY_DELAYS[retries - 1] ?? 5000;
        await new Promise((r) => setTimeout(r, delay));
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        } catch {
          // ignore retry errors
        }
        continue;
      }

      // 页面含 _security_check → 验证已完成
      if (currentUrl.includes("_security_check")) {
        refreshed = true;
        break;
      }

      // 检查 stoken（我们没注入旧的，任何 stoken 都是新生成的）
      const cookies = await browser.cookies("https://www.zhipin.com");
      const stoken = cookies.find((c) => c.name === "__zp_stoken__");
      if (stoken && stoken.value.length > 10 && currentUrl.includes("zhipin.com")) {
        refreshed = true;
        break;
      }
    }

    const finalCookies = await saveBrowserCookies(browser);
    await browser.close();

    const hasStoken = finalCookies.some((c) => c.name === "__zp_stoken__");
    if (!hasStoken) {
      return { ok: false, error: "未能生成 __zp_stoken__，安全验证可能失败" };
    }
    if (!refreshed) {
      return { ok: false, error: "安全验证超时，__zp_stoken__ 未更新" };
    }

    return { ok: true, cookieString: cookiesToString(finalCookies), cookies: finalCookies };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, error: `浏览器错误: ${String(err)}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Login
// ────────────────────────────────────────────────────────────────────────────

export type LoginResult =
  | { ok: true; message: string; cookieString: string }
  | { ok: false; qrPath?: string; message: string };

/**
 * 步骤1：打开登录页，截图
 */
export async function startLogin(proxy?: string): Promise<{
  ok: boolean;
  qrPath?: string;
  message: string;
  _browser?: Browser;
  _page?: Page;
}> {
  let browser: Browser | undefined;
  try {
    browser = await launchBrowser(proxy);
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );

    await page.goto("https://www.zhipin.com/web/user/?ka=header-login", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await new Promise((r) => setTimeout(r, 5000));

    await ensureStateDir();
    const qrPath = getQrScreenshotPath();
    await page.screenshot({ path: qrPath, fullPage: false });

    return {
      ok: false,
      qrPath,
      message: `登录页截图已保存到 ${qrPath}，请扫码登录。`,
      _browser: browser,
      _page: page,
    };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, message: `启动浏览器失败: ${String(err)}` };
  }
}

/**
 * 步骤2：等待用户扫码完成
 */
export async function waitForLogin(
  browser: Browser,
  page: Page,
  timeoutMs = 120_000,
): Promise<LoginResult> {
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const cookies = await browser.cookies("https://www.zhipin.com");
      const hasAuth = cookies.some((c) => c.name === "wt2" && c.value.length > 10);
      if (hasAuth) {
        await saveBrowserCookies(browser);
        const cookieString = cookiesToString(cookies);
        await browser.close();
        return { ok: true, message: "✅ 登录成功！Cookie 已保存。", cookieString };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    await browser.close();
    return { ok: false, message: "⏰ 登录超时（2分钟），请重新发起登录。" };
  } catch (err) {
    await browser.close().catch(() => {});
    return { ok: false, message: `等待登录失败: ${String(err)}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Fetch jobs via browser
// ────────────────────────────────────────────────────────────────────────────

export type BrowserFetchResult =
  | { ok: true; jobs: JobItem[]; cookieString: string }
  | { ok: false; needLogin: boolean; error: string };

/**
 * 使用浏览器拉取岗位 — 自动处理 __zp_stoken__
 */
export async function browserFetchJobs(opts: {
  filters: Filters;
  proxy?: string;
  cookieString: string;
  pageSize?: number;
}): Promise<BrowserFetchResult> {
  const { filters, proxy, cookieString, pageSize = 20 } = opts;
  let browser: Browser | undefined;

  try {
    browser = await launchBrowser(proxy);
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );

    // 注入 Cookie（去掉旧 stoken）
    await injectCookieString(page, cookieString, { stripStoken: true });

    const query = filters.keywords?.join(" ") ?? "java";
    const cityCode =
      filters.cityCodes?.[0] ??
      (filters.cities?.[0] ? resolveCityCode(filters.cities[0]) : "101020100");
    const searchUrl = `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(query)}&city=${cityCode}&page=1&pageSize=${pageSize}`;

    // 拦截 API 响应
    let apiJobs: JobItem[] | null = null;
    page.on("response", async (res) => {
      try {
        if (!res.url().includes("joblist.json")) return;
        const data = await res.json();
        if (data?.code === 0 && data?.zpData?.jobList) {
          apiJobs = (data.zpData.jobList as any[]).map(
            (j: any): JobItem => ({
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
            }),
          );
        }
      } catch {
        // ignore
      }
    });

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // 带延迟重试的等待循环
    let retries = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [2000, 4000, 6000];

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (apiJobs) break;

      // about:blank 延迟重试
      const loopUrl = page.url();
      if (loopUrl === "about:blank" && retries < MAX_RETRIES) {
        retries++;
        const delay = RETRY_DELAYS[retries - 1] ?? 5000;
        await new Promise((r) => setTimeout(r, delay));
        try {
          await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
        } catch {
          // ignore
        }
      }
    }

    // 检查是否被跳转到登录页
    const currentUrl = page.url();
    if (currentUrl.includes("/web/user/") || currentUrl.includes("login")) {
      await browser.close();
      return { ok: false, needLogin: true, error: "Cookie 已过期，请重新登录。" };
    }

    // 保存最新 Cookie
    const finalCookies = await saveBrowserCookies(browser);
    const newCookieString = cookiesToString(finalCookies);
    await browser.close();

    if (apiJobs) {
      return { ok: true, jobs: apiJobs, cookieString: newCookieString };
    }
    return { ok: false, needLogin: false, error: "未能获取岗位数据（API 超时或安全验证未通过）" };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, needLogin: false, error: `浏览器错误: ${String(err)}` };
  }
}

/**
 * 检查是否有保存的浏览器 Cookie
 */
export async function hasSavedBrowserCookies(): Promise<boolean> {
  try {
    const raw = await readFile(getCookiesPath(), "utf8");
    const cookies = JSON.parse(raw);
    return Array.isArray(cookies) && cookies.length > 0;
  } catch {
    return false;
  }
}

/**
 * 从保存的 Cookie 中提取拼接成 HTTP Cookie 字符串
 */
export async function getSavedCookieString(): Promise<string | null> {
  try {
    const raw = await readFile(getCookiesPath(), "utf8");
    const cookies: Cookie[] = JSON.parse(raw);
    if (cookies.length === 0) return null;
    return cookiesToString(cookies);
  } catch {
    return null;
  }
}
