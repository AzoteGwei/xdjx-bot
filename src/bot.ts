import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { handlePanelCallback, handlePanelInput, openPanel } from "./configPanel";
import { handleXdjx } from "./xdjx";

const BOT_INFO_KEY = "bot:info";

export async function createBot(env: Env): Promise<Bot> {
  let botInfo = await env.KV.get<UserFromGetMe>(BOT_INFO_KEY, "json");
  const bot = new Bot(env.BOT_TOKEN, botInfo ? { botInfo } : undefined);
  if (!botInfo) {
    await bot.init();
    botInfo = bot.botInfo;
    await env.KV.put(BOT_INFO_KEY, JSON.stringify(botInfo), { expirationTtl: 86400 });
  }

  bot.command("xdjx", (ctx) => handleXdjx(ctx, env));
  bot.command("xdjx_config", (ctx) => openPanel(ctx, env));
  bot.callbackQuery(/^c:/, (ctx) => handlePanelCallback(ctx, env));
  bot.on("message:text", async (ctx, next) => {
    if (!(await handlePanelInput(ctx, env))) await next();
  });

  bot.catch((err) => console.error("bot error:", err.error));
  return bot;
}
