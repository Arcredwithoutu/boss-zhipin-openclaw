// src/login.ts
// 纯 HTTP API 实现 Boss直聘扫码登录（微信小程序码方式）
// 完全绕过浏览器 anti-bot 检测（browser-check/verify-sdk）
//
// 流程：
// 1. captcha/randkey POST → 获取 shortRandKey
// 2. qrcode/getMpCode GET(uuid=shortRandKey) → 获取微信小程序码图片 URL
// 3. 下载小程序码图片到本地
// 4. 轮询 qrcode/scanByMp(uuid=shortRandKey) 等待扫码
// 5. 扫码后 scanJump 完成登录，获取认证 cookie

import https from "node:https";
import { URL } from "node:url";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_URL = "https://www.zhipin.com";
const STATE_DIR = join(homedir(), ".openclaw", "boss-zhipin");
const QR_IMAGE_PATH = join(STATE_DIR, "qr-login.png");

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function ensureDir(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
}

async function createProxyAgent(proxyUrl: string): Promise<https.Agent> {
  if (proxyUrl.startsWith("socks")) {
    const { SocksProxyAgent } = await import("socks-proxy-agent");
    return new SocksProxyAgent(proxyUrl);
  }
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  return new HttpsProxyAgent(proxyUrl);
}

// 收集 Set-Cookie 响应头
function extractCookies(headers: Record<string, string | string[] | undefined>): string[] {
  const raw = headers["set-cookie"];
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((c) => c.split(";")[0]!);
}

function mergeCookies(existing: string, newCookies: string[]): string {
  if (newCookies.length === 0) return existing;
  const parts = existing ? existing.split("; ").filter(Boolean) : [];
  for (const nc of newCookies) {
    const name = nc.split("=")[0]!;
    const idx = parts.findIndex((p) => p.startsWith(name + "="));
    if (idx !== -1) parts[idx] = nc;
    else parts.push(nc);
  }
  return parts.join("; ");
}

/**
 * 通用 HTTPS GET/POST 请求
 */
function httpRequest(opts: {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  agent?: https.Agent;
  timeoutMs?: number;
}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(opts.url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: opts.method ?? "GET",
        headers: opts.headers,
        agent: opts.agent,
        timeout: opts.timeoutMs ?? 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as any,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/**
 * 下载二进制文件
 */
function httpDownload(opts: {
  url: string;
  agent?: https.Agent;
  timeoutMs?: number;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(opts.url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: "GET",
        agent: opts.agent,
        timeout: opts.timeoutMs ?? 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Download timeout")); });
    req.end();
  });
}

// ─── Login Session ─────────────────────────────────────────────────────────

export type LoginSession = {
  shortRandKey: string;
  qrId: string;
  cookies: string;
  qrImagePath: string;
  createdAt: number;
};

export type StartLoginResult =
  | { ok: true; session: LoginSession; qrPath: string; message: string }
  | { ok: false; message: string };

export type PollLoginResult =
  | { ok: true; cookieString: string; message: string }
  | { ok: false; expired: boolean; message: string };

/**
 * 步骤1：获取微信小程序码并保存到本地
 */
export async function startLogin(proxy?: string): Promise<StartLoginResult> {
  try {
    await ensureDir();
    const agent = proxy ? await createProxyAgent(proxy) : undefined;
    const baseHeaders: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "Referer": "https://www.zhipin.com/web/user/?ka=header-login",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Origin": "https://www.zhipin.com",
    };

    // Step 1: 获取初始 cookies
    const homeRes = await httpRequest({
      url: `${BASE_URL}/web/user/?ka=header-login`,
      headers: { ...baseHeaders, Accept: "text/html" },
      agent,
    });
    let cookies = extractCookies(homeRes.headers).join("; ");

    // Step 2: zpToken
    const tokenRes = await httpRequest({
      url: `${BASE_URL}/wapi/zppassport/set/zpToken`,
      method: "POST",
      headers: { ...baseHeaders, Cookie: cookies },
      agent,
    });
    cookies = mergeCookies(cookies, extractCookies(tokenRes.headers));

    // Step 3: captcha/randkey
    const randRes = await httpRequest({
      url: `${BASE_URL}/wapi/zppassport/captcha/randkey`,
      method: "POST",
      headers: { ...baseHeaders, Cookie: cookies, "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
      agent,
    });
    cookies = mergeCookies(cookies, extractCookies(randRes.headers));

    let randData: any;
    try { randData = JSON.parse(randRes.body); } catch {
      return { ok: false, message: "captcha/randkey 响应解析失败" };
    }
    if (randData?.code !== 0 || !randData?.zpData?.shortRandKey) {
      return { ok: false, message: `captcha/randkey 失败: ${randData?.message ?? randRes.body.substring(0, 200)}` };
    }

    const { qrId, shortRandKey } = randData.zpData;

    // Step 4: getMpCode（获取微信小程序码 URL）
    const mpRes = await httpRequest({
      url: `${BASE_URL}/wapi/zppassport/qrcode/getMpCode?uuid=${encodeURIComponent(shortRandKey)}&width=200`,
      headers: { ...baseHeaders, Cookie: cookies },
      agent,
    });
    cookies = mergeCookies(cookies, extractCookies(mpRes.headers));

    let mpData: any;
    try { mpData = JSON.parse(mpRes.body); } catch {
      return { ok: false, message: "getMpCode 响应解析失败" };
    }
    if (mpData?.code !== 0 || !mpData?.zpData?.mpCodeUrl) {
      return { ok: false, message: `getMpCode 失败: ${mpData?.message ?? mpRes.body.substring(0, 200)}` };
    }

    const mpCodeUrl: string = mpData.zpData.mpCodeUrl;

    // Step 5: 下载微信小程序码图片
    // mpCodeUrl 可能是不同域（img.bosszhipin.com），不需要代理
    const imgBuf = await httpDownload({ url: mpCodeUrl, agent, timeoutMs: 15_000 });
    await writeFile(QR_IMAGE_PATH, imgBuf);

    const session: LoginSession = {
      shortRandKey,
      qrId,
      cookies,
      qrImagePath: QR_IMAGE_PATH,
      createdAt: Date.now(),
    };

    return {
      ok: true,
      session,
      qrPath: QR_IMAGE_PATH,
      message: `微信小程序码已保存到 ${QR_IMAGE_PATH}，请用微信扫码登录 Boss直聘。`,
    };
  } catch (err) {
    return { ok: false, message: `登录初始化失败: ${String(err)}` };
  }
}

/**
 * 步骤2：轮询扫码状态，等待用户完成登录
 *
 * scanByMp 是长轮询 API（服务器持有连接直到扫码或超时）。
 * 扫码后通过 scanJump → loginConfirm 完成认证，获取 wt2/zp_at 等 cookie。
 */
export async function pollLogin(
  session: LoginSession,
  proxy?: string,
  timeoutMs = 120_000,
): Promise<PollLoginResult> {
  const agent = proxy ? await createProxyAgent(proxy) : undefined;
  const baseHeaders: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "Referer": "https://www.zhipin.com/web/user/?ka=header-login",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.zhipin.com",
  };

  let { cookies } = session;
  const startTime = Date.now();

  // QR 码有效期通常 ~60 秒，总超时 2 分钟
  while (Date.now() - startTime < timeoutMs) {
    try {
      const scanRes = await httpRequest({
        url: `${BASE_URL}/wapi/zppassport/qrcode/scanByMp?uuid=${encodeURIComponent(session.shortRandKey)}`,
        headers: { ...baseHeaders, Cookie: cookies },
        agent,
        timeoutMs: 65_000, // 长轮询超时
      });
      cookies = mergeCookies(cookies, extractCookies(scanRes.headers));

      let scanData: any;
      try { scanData = JSON.parse(scanRes.body); } catch { continue; }

      // scanByMp 返回 {scaned: true} 表示用户已扫码
      if (scanData?.scaned) {
        // 扫码成功，尝试确认登录
        const confirmResult = await confirmLogin(session.shortRandKey, cookies, agent, baseHeaders);
        if (confirmResult.ok) {
          return confirmResult;
        }
        // 确认失败，继续轮询（可能需要用户在手机上确认）
        continue;
      }

      // scaned === false，继续轮询
    } catch {
      // 超时或网络错误，继续轮询
      if (Date.now() - startTime >= timeoutMs) break;
    }
  }

  // 检查 QR 码是否过期（3 分钟有效）
  const elapsed = Date.now() - session.createdAt;
  if (elapsed > 180_000) {
    return { ok: false, expired: true, message: "⏰ 二维码已过期，请重新发起登录。" };
  }
  return { ok: false, expired: false, message: "⏰ 登录超时，请重新扫码。" };
}

/**
 * 扫码后确认登录（scanJump 流程）
 */
async function confirmLogin(
  shortRandKey: string,
  cookies: string,
  agent: https.Agent | undefined,
  baseHeaders: Record<string, string>,
): Promise<PollLoginResult> {
  try {
    // 调用 loginConfirm
    const confirmRes = await httpRequest({
      url: `${BASE_URL}/wapi/zppassport/qrcode/loginConfirm?uuid=${encodeURIComponent(shortRandKey)}`,
      headers: { ...baseHeaders, Cookie: cookies },
      agent,
    });
    cookies = mergeCookies(cookies, extractCookies(confirmRes.headers));

    let confirmData: any;
    try { confirmData = JSON.parse(confirmRes.body); } catch {
      return { ok: false, expired: false, message: "loginConfirm 响应解析失败" };
    }

    if (confirmData?.code === 0) {
      // 登录成功，从 cookies 中提取认证信息
      // wt2, zp_at, bst 等是关键认证 cookie
      const hasAuth = cookies.includes("wt2=") || cookies.includes("zp_at=");
      if (hasAuth) {
        return { ok: true, cookieString: cookies, message: "✅ 登录成功！Cookie 已获取。" };
      }
      // 登录成功但 cookie 可能在 redirect 中，尝试获取用户信息验证
      const userRes = await httpRequest({
        url: `${BASE_URL}/wapi/zpuser/wap/getUserInfo.json`,
        headers: { ...baseHeaders, Cookie: cookies },
        agent,
      });
      cookies = mergeCookies(cookies, extractCookies(userRes.headers));
      let userData: any;
      try { userData = JSON.parse(userRes.body); } catch {}
      if (userData?.code === 0) {
        return { ok: true, cookieString: cookies, message: "✅ 登录成功！Cookie 已获取。" };
      }
    }

    return {
      ok: false,
      expired: false,
      message: `loginConfirm 返回 code=${confirmData?.code}: ${confirmData?.message ?? ""}`,
    };
  } catch (err) {
    return { ok: false, expired: false, message: `确认登录失败: ${String(err)}` };
  }
}

/**
 * 获取 QR 图片路径
 */
export function getQrImagePath(): string {
  return QR_IMAGE_PATH;
}
