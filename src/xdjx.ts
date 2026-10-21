import type { CommandContext, Context } from "grammy";
import type { Message } from "grammy/types";
import { addToTotals, estimateCost, pushBillingLog, type BillingLog } from "./billing";
import { loadConfig } from "./config";
import { generateStream } from "./gemini";
import { downloadImage, extractImage } from "./media";
import { StreamingReply } from "./streamReply";
import { ignoreErrors } from "./telegram";

const USAGE = "用法：回复一条消息并发送 /xdjx（可在命令后附加指令）。";

function displayName(user?: { first_name: string; last_name?: string }): string {
  return user ? [user.first_name, user.last_name].filter(Boolean).join(" ") : "未知";
}

/** 同一 update 被 Telegram 重投时只处理一次，避免重复调用与计费。 */
async function isDuplicate(kv: KVNamespace, updateId: number): Promise<boolean> {
  const key = `upd:${updateId}`;
  if (await kv.get(key)) return true;
  await kv.put(key, "1", { expirationTtl: 600 });
  return false;
}

export function buildPrompt(target: Message, quote: string | undefined, instruction: string, maxChars: number) {
  const texts: string[] = [];
  const full = target.text ?? target.caption ?? "";
  const body = full.slice(0, maxChars);
  const sender = target.forward_origin ? "（转发消息）" : displayName(target.from);
  if (body) texts.push(`[被回复的消息 · 发送者：${sender}]\n${body}${full.length > maxChars ? "…（已截断）" : ""}`);
  if (quote) texts.push(`[用户引用的片段]\n${quote.slice(0, maxChars)}`);
  if (instruction) texts.push(`[用户指令]\n${instruction.slice(0, maxChars)}`);
  return { texts, inputChars: body.length };
}

export async function handleXdjx(ctx: CommandContext<Context>, env: Env): Promise<void> {
  const chat = ctx.chat;
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  const { config } = await loadConfig(env);
  if (!config.allowedChatIds.has(chat.id)) return;

  const msg = ctx.message;
  const target = msg?.reply_to_message;
  if (!msg || !target) {
    await ctx.reply(USAGE, { reply_parameters: { message_id: msg?.message_id ?? 0, allow_sending_without_reply: true } });
    return;
  }
  if (await isDuplicate(env.KV, ctx.update.update_id)) return;

  const instruction = ctx.match.trim();
  const { texts, inputChars } = buildPrompt(target, msg.quote?.text, instruction, config.maxInputChars);
  const imageRef = extractImage(target);
  if (!imageRef && texts.length === 0) {
    await ctx.reply("不支持的消息类型：目前只支持文字和图片。", { reply_parameters: { message_id: msg.message_id } });
    return;
  }

  const started = Date.now();
  const log: BillingLog = {
    chat: { id: chat.id, title: chat.title },
    user: { id: msg.from?.id ?? 0, name: displayName(msg.from), username: msg.from?.username },
    targetMessageId: target.message_id,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    inputChars,
    instructionChars: instruction.length,
    durationMs: 0,
    status: "pending",
  };

  await ignoreErrors(ctx.replyWithChatAction("typing"));
  const typing = setInterval(() => void ignoreErrors(ctx.replyWithChatAction("typing")), 4500);
  const reply = new StreamingReply(ctx.api, chat.id, target.message_id, config.maxReplyChars);
  let partial = "";
  try {
    const image = imageRef ? await downloadImage(ctx.api, env.BOT_TOKEN, imageRef) : undefined;
    if (image) log.image = { mimeType: image.mimeType, bytes: image.bytes };
    if (texts.length === 0) texts.push("[被回复的消息为一张图片]");

    const result = await generateStream(env.GEMINI_API_KEY, config, { texts, image }, async (text) => {
      partial = text;
      clearInterval(typing);
      await reply.update(text.trim());
    });
    log.status = result.status;
    log.usage = result.usage;
    log.cost = estimateCost(result.usage, config);
    log.totals = await addToTotals(env.KV, result.usage, log.cost);

    let text = result.text.trim() || "（模型没有返回内容）";
    if (result.status === "incomplete") text += "\n…（输出达到长度上限，已截断）";
    log.replyChars = await reply.finish(text);
  } catch (e) {
    log.status = log.status === "pending" ? "error" : log.status;
    log.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error("xdjx failed:", e);
    if (reply.started) await ignoreErrors(reply.finish(`${partial.trim()}\n…（生成中断，请稍后再试）`));
    else await ignoreErrors(ctx.reply("出错了，请稍后再试。", { reply_parameters: { message_id: msg.message_id } }));
  } finally {
    clearInterval(typing);
    log.durationMs = Date.now() - started;
    await pushBillingLog(ctx.api, config, log);
  }
}
