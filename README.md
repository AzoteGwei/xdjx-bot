# xdjx_bot

A Telegram bot running on Cloudflare Workers that calls the Gemini API (Google AI Studio) through its Interactions API.

## 用法

- **群内**：回复一条消息（文字 / 图片 / 图文）并发送 `/xdjx [可选附加指令]`。只在 `ALLOWED_CHAT_IDS` 白名单群中响应。
- **管理员**：发送 `/xdjx_config` 打开单消息配置面板。私聊校验 chat id，群聊校验 user id。点按钮多轮修改；文本类配置项通过**回复面板消息**输入；最后点 `✖ 关闭`。
- **计费**：每次调用都向 `BILLING_CHAT_ID` 推送详细日志，包括 tokens、预估成本、累计成本、耗时和错误信息。

## 配置

| 来源 | 内容 |
|---|---|
| Secret | `BOT_TOKEN`、`GEMINI_API_KEY`（仅此两项） |
| `wrangler.jsonc` → `vars` | 默认值：`ADMIN_USER_ID`、`ALLOWED_CHAT_IDS`、`SYSTEM_PROMPT`、`MODEL`、`THINKING_LEVEL`、`MAX_OUTPUT_TOKENS`、`MAX_INPUT_CHARS`、`MAX_REPLY_CHARS`、`BILLING_CHAT_ID`、`PRICE_*_PER_M` |
| KV `cfg:overrides` | `/xdjx_config` 中的修改，覆盖 vars；可单项恢复默认。`ADMIN_USER_ID` 只能在 vars 中修改 |

默认模型为 `gemini-4-argon`（无免费层，需付费 key）。默认价格是 2026-11-30 之前的 $2 / $10 / $0.1（input / output / cached，每 1M tokens）；2026-12-01 起涨为 $4 / $20 / $0.2，届时请在面板里更新。

## 部署

```sh
pnpm i
pnpm wrangler kv namespace create KV      # 把 id 填入 wrangler.jsonc
pnpm wrangler secret put BOT_TOKEN
pnpm wrangler secret put GEMINI_API_KEY
# 编辑 wrangler.jsonc 中的 ADMIN_USER_ID 等 vars
pnpm run deploy
cp .dev.vars.example .dev.vars            # 填入 BOT_TOKEN，供下一步脚本使用
pnpm webhook:set https://xdjx-bot.<subdomain>.workers.dev/
```

把 Bot 拉进目标群和计费 chat。Privacy Mode 保持开启即可。如果希望 Bot 删除管理员输入配置时发的回复，需要给它删除消息的权限（可选）。

Webhook 的 `secret_token` 由 `BOT_TOKEN` 派生（见 `src/webhook.ts`），因此不需要额外的 secret。

## 开发

```sh
pnpm dev          # 本地运行（可配合 cloudflared tunnel + webhook:set 联调）
pnpm test         # 单元测试
pnpm typecheck    # wrangler types + tsc
pnpm wrangler tail
```
