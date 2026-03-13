# Boss直聘 Cookie 保活可行性测试报告

**测试开始**: 2026-03-13T06:29:40Z (UTC)
**测试结束**: 2026-03-13T06:36:00Z (UTC)
**Cookie 获取时间**: 2026-03-13T03:19:59Z
**Cookie 年龄**: 3.2 小时
**代理**: socks5://127.0.0.1:1080

---

## 第一轮：Set-Cookie 被动续期测试

| 编号 | 测试项 | 结果 | Set-Cookie 数 | 认证Cookie续期 |
|------|--------|------|---------------|----------------|
| T1 | API joblist.json Set-Cookie | PASS ✅ | 3 | - |
| T2 | getUserInfo Set-Cookie | FAIL ❌ | 0 | - |
| T3 | HTML 页面 Set-Cookie | FAIL ❌ | 0 | - |
| T4 | 认证 Cookie 续期分析 | FAIL ❌ | 0 | - |
| T5 | 合并 Cookie 可用性验证 | PASS ✅ | 3 | - |
| T6 | zpToken 接口 Set-Cookie | PASS ✅ | 1 | bst (8天有效期) |

**发现**：
- `zpToken POST` 能续期 `bst` cookie（有效期 ~8 天，Expires=Sat, 21-Mar-2026）
- `wt2` 和 `zp_at` 在所有 HTTP 端点中均无 Set-Cookie 返回
- API joblist.json 返回 3 个安全相关 cookie（`__zp_sseed__`、`__zp_sname__`、`__zp_sts__`），无认证 cookie

---

## 第二轮：wt2/zp_at 续期端点探索

| 编号 | 端点 | Set-Cookie | 认证Cookie |
|------|------|-----------|-----------|
| R1 | zppassport/get/zpToken (GET) | ❌ 无 | - |
| R2 | zppassport/set/zpToken (POST) | ✅ bst | bst (8天) |
| R3 | zpuser/wap/getUserInfo | ❌ 无 | - |
| R4 | zpgeek/friend/getGeekFriendList | ❌ 404 | - |
| R5 | zpCommon/data/getCondition | ❌ 404 | - |
| R6 | 首页 / | ❌ 无 | - |
| R7 | 个人中心 /web/geek/recommend | ❌ 无 | - |
| R8 | 消息页 /web/geek/chat | ❌ 无 | - |
| R9 | checkLogin (GET) | ❌ 404 | - |
| R10 | checkLogin (POST) | ❌ code=121 | - |
| R11 | 简历页 /web/geek/resume | ❌ 无 | - |

**结论**：**没有任何 HTTP 端点能续期 `wt2` 和 `zp_at`。** 这两个 cookie 只在初次登录时设置。

---

## 第三轮：Cookie 必要性分析 & __zp_stoken__ 关键性验证

### 3a: 环境异常检测

**背景**：3 小时后再次调用 API 返回 `code=37, message=您的环境存在异常`。

| 测试 | 结果 | 说明 |
|------|------|------|
| 完整 Cookie 调 API | code=37 ❌ | `__zp_stoken__` 已过期 |
| zpToken 刷新后调 API | code=37 ❌ | zpToken 只刷新 bst，不生成 __zp_stoken__ |
| 去掉 __zp_stoken__ 调 API | code=37 ❌ | 没有 stoken 同样被拦截 |
| 最小 Cookie 集 (wt2+zp_at+bst) | code=37 ❌ | 确认缺少 stoken 无法通过 |

**关键发现**：`code=37` 不是 Cookie 过期，而是 `__zp_stoken__` 过期导致的环境异常检测。

### 3b: Puppeteer stoken 刷新验证

| 测试 | 结果 | 说明 |
|------|------|------|
| Puppeteer refreshToken 刷新 stoken | ✅ 成功 | 浏览器 verify-sdk 生成新 __zp_stoken__ |
| 刷新后调 API | code=0, jobs=3 ✅ | **证明 wt2/zp_at 在 3+ 小时后仍然有效** |

**核心结论**：`wt2`/`zp_at` 未过期，问题完全出在 `__zp_stoken__`。

---

## 综合结论

### Cookie 生命周期模型

```
wt2/zp_at: ────────────────────────────────→ (长期有效，可能数天~数周，不可通过 HTTP 续期)
bst:       ──── 8天 ────→ (可通过 zpToken POST 续期)
__zp_stoken__: ──5min──→ (前端 verify-sdk 生成，只能通过浏览器刷新)
```

### 保活策略修正

| 层级 | 策略 | 可行性 |
|------|------|--------|
| **__zp_stoken__ 刷新** | Puppeteer refreshToken（每次 API 调用前刷新） | ✅ 已实现，是核心保活手段 |
| **bst 续期** | POST zpToken（每 2 小时一次） | ✅ 可行，延长 bst 有效期到 8 天 |
| **wt2/zp_at 续期** | 无 HTTP 续期途径 | ❌ 不可行，只能在过期后重新扫码 |
| **被动 Set-Cookie 捕获** | 从 API 响应中提取 Set-Cookie | ⚠️ 有限价值，只能更新安全 cookie |

### 实际保活流程

1. **每次拉取**：Puppeteer 刷新 `__zp_stoken__` → HTTP API 拉取岗位 → 回写 cookie（已由 `boss_browser_fetch` 实现）
2. **每 2 小时**：POST zpToken 续期 `bst`（新增）
3. **wt2/zp_at 过期时**：自动检测 → 弹出微信扫码二维码（已实现，但需要用户参与）

### 关键洞察

> **真正的保活瓶颈不是 Cookie 过期，而是 `__zp_stoken__` 的 5 分钟有效期。**
>
> 当前架构中 `boss_browser_fetch` 已经在每次拉取前通过 Puppeteer 刷新 stoken，
> 这意味着只要 Puppeteer + Xvfb + Stealth 正常工作，登录态就能持续维持，
> 直到 `wt2`/`zp_at` 自然过期（时间未知，需要长期观测）。
>
> **建议**：添加 `wt2`/`zp_at` 过期时间的长期观测（记录每次登录的 cookie 值和 API 返回 code=37 的时间），
> 确定真实有效期后再决定是否需要更频繁的扫码登录。
