// 用法：pnpm webhook:set https://xdjx-bot.<subdomain>.workers.dev/
// 读取 .dev.vars 或环境变量中的 BOT_TOKEN（应与线上 secret 相同）。
import { existsSync, readFileSync } from "node:fs";
import { deriveWebhookSecret } from "../src/webhook";

function readDevVars(): Record<string, string> {
  if (!existsSync(".dev.vars")) return {};
  return Object.fromEntries(
    readFileSync(".dev.vars", "utf8")
      .split("\n")
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[1]!, m[2]!]),
  );
}

const url = process.argv[2];
const token = process.env.BOT_TOKEN ?? readDevVars().BOT_TOKEN;
if (!url || !token) {
  console.error("Usage: pnpm webhook:set <worker-url>   (BOT_TOKEN from env or .dev.vars)");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: await deriveWebhookSecret(token),
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  }),
});
console.log(await res.json());

// 命令提示由 /xdjx_hinton、/xdjx_hintoff 按 chat 注册；清空默认 scope，否则 hintoff 后仍会回落到默认命令。
const commands = await fetch(`https://api.telegram.org/bot${token}/deleteMyCommands`, { method: "POST" });
console.log(await commands.json());
