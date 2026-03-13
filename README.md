# Openclaw集成Boss直聘岗位推送 (boss-zhipin)

基于 [OpenClaw](https://github.com/nicepkg/openclaw) 的 Boss直聘岗位定时推送插件，支持将符合筛选条件的新岗位自动推送到飞书、企业微信、Telegram 等 IM 渠道。

配置后可以实现让openclaw定时推送感兴趣岗位，也可以向openclaw发起请求直接进行拉取，有效提高金三银四期间的求职效率，openclaw小巧思属于是。在多次迭代后实现了cookie的稳定自动更新与使用。

![6ab9d38e262191ca593c932a00012131](https://github.com/user-attachments/assets/6399dcae-e109-4cc5-a0a5-c5bad09c0c7a)

## 功能概览

- **定时推送** — 每 3 小时自动拉取新岗位并推送到 IM（可自定义频率）
- **多渠道投递** — 支持飞书（Feishu）、企业微信（WeCom）、Telegram，未配置的渠道自动跳过
- **岗位筛选** — 支持按城市、薪资范围、关键词、发布时间筛选
- **IM 动态配置** — Cookie 和筛选条件均可通过 IM 对话实时调整，无需修改配置文件
- **智能去重** — 已推送岗位 7 天内不会重复推送
- **Cookie 失效感知** — 自动检测登录态过期并提醒用户更新
- **扫码登录** — 纯 HTTP API 获取微信小程序码，绕过反爬虫检测，无需手动复制 Cookie
- **代理支持** — 支持 SOCKS5/HTTP 代理，适用于海外服务器访问 Boss直聘

## 工作原理

### 架构

```
┌──────────────────────────────────────────────────────┐
│                   OpenClaw Gateway                    │
│                                                      │
│  ┌─────────────┐    ┌──────────────────────────────┐ │
│  │  Cron 调度器  │───▶│  Isolated Agent Session      │ │
│  │ (每3小时)    │    │                              │ │
│  └─────────────┘    │  1. 调用 boss_fetch_jobs      │ │
│                     │  2. 获取 + 过滤 + 去重         │ │
│                     │  3. 格式化 Markdown            │ │
│                     │  4. announce 到 IM 渠道        │ │
│                     └──────────────────────────────┘ │
│                                                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Agent Tools (注册到所有 session)                 │ │
│  │  • boss_browser_login  — 扫码登录(纯HTTP API)    │ │
│  │  • boss_browser_fetch  — 浏览器模式拉取岗位      │ │
│  │  • boss_update_cookie  — 更新登录 Cookie         │ │
│  │  • boss_set_proxy      — 设置代理地址            │ │
│  │  • boss_set_filters    — 设置筛选条件            │ │
│  │  • boss_fetch_jobs     — 拉取岗位列表            │ │
│  │  • boss_get_status     — 查看配置状态            │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
┌─────────────────┐     ┌──────────────────────┐
│  Boss直聘 Web API │     │  ~/.openclaw/         │
│  (Cookie 认证)    │     │  boss-zhipin/         │
│                   │     │  ├── state.json       │
│  /wapi/zpgeek/    │     │  └── dedupe-jobs.json │
│  search/joblist   │     └──────────────────────┘
└─────────────────┘
```

### 数据流

1. **定时推送流程**：OpenClaw Cron 调度器每 3 小时触发一个隔离 Agent Session → Agent 调用 `boss_fetch_jobs` 工具 → 工具内部携带用户 Cookie 请求 Boss直聘 Web API → 对结果进行薪资/时间过滤和去重 → 格式化为 Markdown → 通过 OpenClaw 的 announce 机制推送到已配置的 IM 渠道

2. **主动拉取流程**：用户在 IM 中发送请求（如"帮我拉取最新岗位"）→ OpenClaw Agent 调用 `boss_fetch_jobs` 工具 → 返回格式化结果

3. **配置管理流程**：用户在 IM 中发送 Cookie 或筛选条件 → Agent 调用 `boss_update_cookie` 或 `boss_set_filters` → 写入 `state.json` 持久化

### 文件结构

```
~/.openclaw/extensions/boss-zhipin/
├── index.ts              # 插件入口：注册工具 + Cron 服务
├── package.json
├── tsconfig.json
├── openclaw.plugin.json  # 插件元数据 & 配置 Schema
└── src/
    ├── types.ts           # 类型定义 (Filters, JobItem, PluginState)
    ├── storage.ts         # 状态持久化 (state.json 读写)
    ├── fetcher.ts         # Boss直聘 HTTP API 调用
    ├── filter.ts          # 薪资/时间过滤 + 持久化去重
    ├── formatter.ts       # Markdown 格式化输出
    ├── login.ts           # 纯 HTTP API 扫码登录模块
    ├── browser.ts         # Puppeteer 浏览器模块 (stoken 刷新)
    └── tools.ts           # 7 个 Agent 工具定义
```

### 状态存储

插件状态保存在 `~/.openclaw/boss-zhipin/state.json`：

```json
{
  "cookie": "wt2=...; zp_at=...; bst=...",
  "cookieUpdatedAt": "2026-03-08T12:00:00.000Z",
  "cookieExpired": false,
  "proxy": "socks5://127.0.0.1:1080",
  "filters": {
    "cities": ["北京", "上海"],
    "salary": { "min": 15, "max": 40 },
    "keywords": ["Java", "后端"],
    "publishedWithin": "3h"
  }
}
```

去重记录保存在 `~/.openclaw/boss-zhipin/dedupe-jobs.json`，使用 OpenClaw SDK 的 `createPersistentDedupe`，TTL 为 7 天。

## 安装配置

### 前置条件

- [OpenClaw](https://github.com/nicepkg/openclaw) >= 2026.2.24 已安装并运行
- 至少一个 IM 渠道（飞书/企业微信/Telegram）已在 OpenClaw 中配置

### 第一步：安装插件

将插件目录放到 `~/.openclaw/extensions/boss-zhipin/`，然后安装依赖：

```bash
cd ~/.openclaw/extensions/boss-zhipin
npm install
```

### 第二步：注册插件

编辑 `~/.openclaw/openclaw.json`，在 `plugins` 部分添加：

```json
{
  "plugins": {
    "entries": {
      "boss-zhipin": {
        "enabled": true
      }
    },
    "installs": {
      "boss-zhipin": {
        "source": "local",
        "spec": "boss-zhipin",
        "installPath": "/root/.openclaw/extensions/boss-zhipin",
        "version": "1.0.0",
        "resolvedName": "boss-zhipin",
        "resolvedVersion": "1.0.0"
      }
    }
  }
}
```

### 第三步：配置推送渠道（可选）

如果需要指定推送目标，在 `plugins.entries.boss-zhipin` 中添加 `config`：

```json
{
  "boss-zhipin": {
    "enabled": true,
    "config": {
      "deliveryChannels": ["wecom", "telegram", "feishu"],
      "deliveryTarget": {
        "wecom": "user:zhangsan",
        "telegram": "-1001234567890",
        "feishu": "ou_xxxxxxxxxxxx"
      },
      "cronExpr": "0 */3 * * *",
      "cronTz": "Asia/Shanghai",
      "proxy": "socks5://127.0.0.1:1080"
    }
  }
}
```

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `deliveryChannels` | 推送渠道列表 | `["feishu", "wecom", "telegram"]` |
| `deliveryTarget` | 各渠道推送目标 ID | 空（使用 last route） |
| `cronExpr` | Cron 表达式 | `0 */3 * * *`（每3小时） |
| `cronTz` | 时区 | `Asia/Shanghai` |
| `proxy` | SOCKS5/HTTP 代理地址 | 空（直连） |

> 如果不配置 `deliveryTarget`，插件会推送到 Agent 最后一次回复的渠道（last route）。

### 第四步：重启 Gateway

```bash
openclaw restart
```

插件会在 Gateway 启动时自动注册 Cron 定时任务。

## 使用方法

### 1. 扫码登录（推荐）

在 IM 中发送：

```
帮我登录 Boss直聘
```

Agent 会调用 `boss_browser_login` 工具，通过纯 HTTP API 获取微信小程序码图片：

1. Agent 返回一张微信小程序码图片
2. 用微信扫描该二维码
3. 在手机上确认登录
4. Agent 自动检测登录成功并保存 Cookie

> **技术说明**：该功能通过逆向 Boss直聘登录页 JS 发现的纯 HTTP API 链路实现，完全绕过了 `browser-check.min.js` 反爬虫检测（该 SDK 会在 2 秒内将 Puppeteer 自动化浏览器重定向到 `about:blank`）。API 流程：`captcha/randkey` → `qrcode/getMpCode` → `qrcode/scanByMp`（长轮询）→ `qrcode/loginConfirm`。

### 2. 手动上传 Cookie（备用）

如果扫码登录不可用，可以手动获取 Cookie：

1. 在浏览器中登录 [Boss直聘](https://www.zhipin.com)
2. 打开开发者工具（F12）→ Network 面板
3. 复制任意请求的 `Cookie` 请求头

在 IM 中发送给 Agent：

```
我的 Boss直聘 Cookie 是：wt2=xxxxx; zp_at=xxxxx; bst=xxxxx ...
```

Agent 会自动调用 `boss_update_cookie` 工具保存。

### 3. 设置代理

如果服务器在海外，需要配置代理才能访问 Boss直聘：

```
设置 Boss直聘代理为 socks5://127.0.0.1:1080
```

Agent 会调用 `boss_set_proxy` 保存代理地址。支持 SOCKS5 和 HTTP 代理格式。也可以在插件配置中设置 `proxy` 字段。

### 4. 设置筛选条件

在 IM 中直接描述你的筛选需求：

```
帮我设置筛选条件：城市北京和上海，薪资 20-40k，关键词 Java、Spring Boot，发布时间 3 小时内
```

Agent 会调用 `boss_set_filters` 更新筛选条件，后续定时推送和主动拉取都会使用这些条件。

支持的筛选参数：

| 参数 | 说明 | 示例 |
|------|------|------|
| `cities` | 城市名列表 | 北京、上海、广州、深圳、杭州、成都、武汉、南京、西安、重庆、天津、苏州 |
| `salaryMin` / `salaryMax` | 薪资范围（千元） | 15 = 15K |
| `keywords` | 岗位关键词 | Java、前端、React |
| `publishedWithin` | 发布时间窗口 | `3h`、`24h`、`7d` |

### 5. 主动拉取

```
帮我拉取 10 条最新的 Java 岗位（不去重）
```

Agent 会调用 `boss_fetch_jobs(limit=10, deduplicate=false)` 并返回结果。

### 6. 查看状态

```
查看 Boss直聘插件状态
```

Agent 会调用 `boss_get_status` 显示当前 Cookie 状态和筛选条件。

### 7. 定时推送

配置完成后，插件每 3 小时自动执行一次（可通过 `cronExpr` 调整）：

- 有新岗位 → 格式化推送到 IM
- 无新岗位 → 静默，不发送消息
- Cookie 失效 → 发送提醒，要求用户更新

手动触发一次推送：

```bash
openclaw cron list                    # 查看 job ID
openclaw cron run <jobId>             # 手动执行
openclaw cron runs --id <jobId>       # 查看运行历史
```

## 推送消息示例

```
📋 Boss直聘 · 3 条新岗位（2026/3/8 14:00:00）

━━━━━━━━━━━━━━━━━
【高级Java工程师】 阿里巴巴集团 · 互联网 · 10000人以上
📍 北京-朝阳区
💰 25-50K·16薪
📌 要求：3-5年 / 本科
🏷️ 技能：Java, Spring, MySQL, Redis
🔗 https://www.zhipin.com/job_detail/xxxxx.html

━━━━━━━━━━━━━━━━━
【Java后端开发】 字节跳动 · 互联网 · 10000人以上
📍 北京-海淀区
💰 30-60K·15薪
📌 要求：1-3年 / 本科
🏷️ 技能：Java, Go, Kafka, K8s
🔗 https://www.zhipin.com/job_detail/yyyyy.html
```

## 常见问题

### Cookie 多久失效？

Boss直聘的 Cookie 有效期通常为 1-7 天，具体取决于登录方式。失效后插件会自动检测并通过 IM 提醒你重新上传。

### 为什么没有收到推送？

1. 确认 Gateway 正在运行：`openclaw status`
2. 确认 Cron 任务已注册：`openclaw cron list`
3. 确认 Cookie 有效：在 IM 中发送"查看 Boss直聘插件状态"
4. 查看运行历史：`openclaw cron runs --id <jobId>`

### 如何修改推送频率？

在 `openclaw.json` 的插件配置中修改 `cronExpr`：

```json
"cronExpr": "0 */6 * * *"   // 每6小时
"cronExpr": "0 9,18 * * *"  // 每天9点和18点
"cronExpr": "0 */1 * * *"   // 每小时（注意 Boss直聘可能限速）
```

修改后需要删除旧的 Cron 任务并重启 Gateway：

```bash
openclaw cron list                    # 找到 job ID
openclaw cron remove <jobId>          # 删除旧任务
openclaw restart                      # 重启后自动创建新任务
```

### 支持哪些城市？

插件内置了 12 个常用城市的代码映射：北京、上海、广州、深圳、杭州、成都、武汉、南京、西安、重庆、天津、苏州。如果需要其他城市，可以直接传城市代码（在 Boss直聘 URL 中可以找到）。

### 请求被限速怎么办？

Boss直聘对高频请求有限速机制。如果遇到限速：
- 适当增大 `cronExpr` 间隔
- 减少筛选的城市数量（多城市会发起多次请求）
- 避免在短时间内频繁主动拉取

## 技术细节

- **运行环境**：OpenClaw Gateway 进程内（TypeScript ESM）
- **数据获取**：Node.js `fetch` 调用 Boss直聘 Web API (`/wapi/zpgeek/search/joblist.json`)
- **扫码登录**：纯 HTTP API 实现（`login.ts`），通过 `captcha/randkey` → `qrcode/getMpCode` → `qrcode/scanByMp` → `qrcode/loginConfirm` 链路完成微信小程序码扫码登录，绕过 `browser-check.min.js` 反爬虫检测
- **stoken 刷新**：Puppeteer headless 浏览器（`browser.ts`）+ Stealth 插件 + Xvfb headed 模式
- **认证方式**：Cookie 请求头 + 浏览器 User-Agent
- **代理支持**：SOCKS5（`socks-proxy-agent`）/ HTTP（`https-proxy-agent`），适用于海外服务器
- **失效检测**：API 返回 `code: 37` 时标记 Cookie 失效
- **状态持久化**：`readJsonFileWithFallback` / `writeJsonFileAtomically` (openclaw/plugin-sdk)
- **去重机制**：`createPersistentDedupe` (openclaw/plugin-sdk)，基于 `encryptJobId`，7 天 TTL
- **定时调度**：OpenClaw Cron（Gateway 内置调度器），isolated session 模式

## License

MIT
