import { InlineKeyboard, type CallbackQueryContext, type CommandContext, type Context } from "grammy";
import { formatUsd, getTotals, resetTotals, sendToBillingChats } from "./billing";
import {
  adminIds,
  FIELDS,
  fieldAt,
  fieldIndex,
  loadConfig,
  parseValue,
  setOverride,
  type ConfigKey,
  type Field,
  type LoadedConfig,
} from "./config";
import { escapeHtml, ignoreErrors, truncate } from "./telegram";

const SESSION_TTL = 3600;

interface Session {
  ownerId: number;
  awaiting?: ConfigKey;
}

interface View {
  text: string;
  keyboard: InlineKeyboard;
}

const sessionKey = (chatId: number, messageId: number) => `cfgsess:${chatId}:${messageId}`;

async function getSession(kv: KVNamespace, chatId: number, messageId: number): Promise<Session | null> {
  return kv.get<Session>(sessionKey(chatId, messageId), "json");
}

async function putSession(kv: KVNamespace, chatId: number, messageId: number, s: Session): Promise<void> {
  await kv.put(sessionKey(chatId, messageId), JSON.stringify(s), { expirationTtl: SESSION_TTL });
}

/** 私聊校验 chat id，群聊校验 user id。 */
export function isAdmin(env: Env, chat: { id: number; type: string }, fromId: number | undefined): boolean {
  const admins = adminIds(env);
  return admins.has(chat.type === "private" ? chat.id : (fromId ?? NaN));
}

function display(value: string): string {
  return value === "" ? "（空）" : value;
}

function closeRow(kb: InlineKeyboard, back?: string): InlineKeyboard {
  if (back) kb.text("⬅️ 返回", back);
  return kb.text("✖ 关闭", "c:x");
}

function hint(field: Field): string {
  switch (field.type) {
    case "idlist":
      return "多个 ID 用逗号分隔（群 ID 通常以 -100 开头；用户 ID 为正数，需先私聊 Bot 点 Start），发送 - 清空。";
    case "int":
      return `整数，范围 ${field.min} ~ ${field.max}。`;
    case "float":
      return "非负数字。";
    case "enum":
      return "模型 ID，例如 gemini-3.8-flash。";
    case "text":
      return "任意文本（Telegram 单条消息最多 4096 字符）。";
  }
}

export function renderHome(loaded: LoadedConfig, notice?: string): View {
  const kb = new InlineKeyboard();
  FIELDS.forEach((f, i) => {
    const overridden = loaded.overrides[f.key] !== undefined;
    const value = truncate(display(loaded.raw[f.key]).replace(/\s+/g, " "), 20);
    kb.text(`${f.label}：${value}${overridden ? " ✎" : ""}`, `c:f:${i}`).row();
  });
  kb.text("🧾 计费统计", "c:b");
  closeRow(kb);
  const text = [
    "<b>⚙️ xdjx 配置</b>",
    "点击下方按钮查看或修改，✎ 表示已覆盖 env 默认值。",
    notice ? `\n${notice}` : "",
  ].join("\n");
  return { text, keyboard: kb };
}

export function renderField(loaded: LoadedConfig, index: number, notice?: string): View {
  const field = fieldAt(index)!;
  const value = loaded.raw[field.key];
  const overridden = loaded.overrides[field.key] !== undefined;
  const kb = new InlineKeyboard();
  if (field.type === "enum") {
    field.options.forEach((opt, oi) => {
      kb.text(`${opt === value ? "✓ " : ""}${opt}`, `c:s:${index}:${oi}`);
      if (oi % 2 === 1) kb.row();
    });
    kb.row();
    if (field.custom) kb.text("✏️ 自定义", `c:e:${index}`).row();
  } else {
    kb.text("✏️ 修改", `c:e:${index}`).row();
  }
  if (overridden) kb.text("↩️ 恢复默认", `c:r:${index}`).row();
  closeRow(kb, "c:h");
  const text = [
    `<b>${escapeHtml(field.label)}</b>（<code>${field.key}</code>）`,
    `状态：${overridden ? "已覆盖" : "使用 env 默认值"}`,
    `当前值：<pre>${escapeHtml(truncate(display(value), 1500))}</pre>`,
    overridden ? `默认值：<pre>${escapeHtml(truncate(display(loaded.defaults[field.key]), 1000))}</pre>` : "",
    notice ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  return { text, keyboard: kb };
}

export function renderAwait(index: number, error?: string): View {
  const field = fieldAt(index)!;
  const kb = new InlineKeyboard().text("取消", `c:f:${index}`);
  closeRow(kb);
  const text = [
    `<b>修改：${escapeHtml(field.label)}</b>`,
    "请<b>回复本消息</b>发送新值。",
    escapeHtml(hint(field)),
    error ? `\n❌ ${escapeHtml(error)}` : "",
  ].join("\n");
  return { text, keyboard: kb };
}

async function renderBilling(kv: KVNamespace, confirmReset = false, notice?: string): Promise<View> {
  const t = await getTotals(kv);
  const kb = new InlineKeyboard();
  if (confirmReset) kb.text("⚠️ 确认清零", "c:by").text("取消", "c:b").row();
  else kb.text("📨 测试推送", "c:bt").text("🗑 清零", "c:bc").row();
  closeRow(kb, "c:h");
  const text = [
    "<b>🧾 计费统计</b>",
    `统计起点：${escapeHtml(t.since)}`,
    `调用次数：${t.calls}`,
    `Input tokens：${t.input}`,
    `Output tokens（含 thinking）：${t.output}`,
    `累计预估成本：${formatUsd(t.cost)}`,
    notice ?? "",
  ].join("\n");
  return { text, keyboard: kb };
}

async function editPanel(ctx: Context, chatId: number, messageId: number, view: View): Promise<void> {
  await ignoreErrors(
    ctx.api.editMessageText(chatId, messageId, view.text, { parse_mode: "HTML", reply_markup: view.keyboard }),
  );
}

export async function openPanel(ctx: CommandContext<Context>, env: Env): Promise<void> {
  if (!isAdmin(env, ctx.chat, ctx.from?.id)) return;
  const view = renderHome(await loadConfig(env));
  const sent = await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
  await putSession(env.KV, ctx.chat.id, sent.message_id, { ownerId: ctx.from!.id });
}

export async function handlePanelCallback(ctx: CallbackQueryContext<Context>, env: Env): Promise<void> {
  const msg = ctx.callbackQuery.message;
  const chat = msg?.chat;
  if (!msg || !chat) return void (await ctx.answerCallbackQuery());
  const session = await getSession(env.KV, chat.id, msg.message_id);
  if (!isAdmin(env, chat, ctx.from.id) || (session && session.ownerId !== ctx.from.id)) {
    return void (await ctx.answerCallbackQuery({ text: "无权限", show_alert: true }));
  }
  if (!session) {
    await ctx.answerCallbackQuery({ text: "面板已过期，请重新发送 /xdjx_config" });
    await ignoreErrors(ctx.editMessageReplyMarkup({ reply_markup: undefined }));
    return;
  }

  const [, action, a, b] = ctx.callbackQuery.data.split(":");
  const index = Number(a);
  const field = a !== undefined ? fieldAt(index) : undefined;
  const save = (s: Session) => putSession(env.KV, chat.id, msg.message_id, s);
  let view: View | undefined;
  let toast: string | undefined;

  switch (action) {
    case "h":
      if (session.awaiting) await save({ ownerId: session.ownerId });
      view = renderHome(await loadConfig(env));
      break;
    case "f":
      if (!field) break;
      if (session.awaiting) await save({ ownerId: session.ownerId });
      view = renderField(await loadConfig(env), index);
      break;
    case "e":
      if (!field) break;
      await save({ ownerId: session.ownerId, awaiting: field.key });
      view = renderAwait(index);
      break;
    case "s": {
      const opt = field?.type === "enum" ? field.options[Number(b)] : undefined;
      if (!field || opt === undefined) break;
      await setOverride(env, field.key, opt);
      toast = `已设置为 ${opt}`;
      view = renderField(await loadConfig(env), index, `✅ 已设置为 <code>${escapeHtml(opt)}</code>`);
      break;
    }
    case "r":
      if (!field) break;
      await setOverride(env, field.key, null);
      toast = "已恢复默认";
      view = renderField(await loadConfig(env), index, "✅ 已恢复 env 默认值");
      break;
    case "b":
      view = await renderBilling(env.KV);
      break;
    case "bc":
      view = await renderBilling(env.KV, true);
      break;
    case "bt": {
      const { config } = await loadConfig(env);
      const results = await sendToBillingChats(ctx.api, config, "🧾 xdjx 计费推送测试");
      const lines = results.map((r) =>
        r.error ? `❌ <code>${r.chatId}</code>：${escapeHtml(r.error)}` : `✅ <code>${r.chatId}</code>`,
      );
      view = await renderBilling(env.KV, false, lines.length ? `\n${lines.join("\n")}` : "⚠️ 未配置计费推送 chat");
      break;
    }
    case "by":
      await resetTotals(env.KV);
      toast = "已清零";
      view = await renderBilling(env.KV, false, "✅ 已清零");
      break;
    case "x":
      await env.KV.delete(sessionKey(chat.id, msg.message_id));
      await ctx.answerCallbackQuery({ text: "已关闭" });
      if (!(await ignoreErrors(ctx.deleteMessage()))) {
        await ignoreErrors(ctx.editMessageText("⚙️ 配置面板已关闭。", { reply_markup: undefined }));
      }
      return;
  }

  await ctx.answerCallbackQuery(toast ? { text: toast } : undefined);
  if (view) await editPanel(ctx, chat.id, msg.message_id, view);
}

/** 管理员回复面板消息输入新值。返回 true 表示已处理。 */
export async function handlePanelInput(ctx: Context, env: Env): Promise<boolean> {
  const msg = ctx.message;
  const panel = msg?.reply_to_message;
  if (!msg?.text || !panel || panel.from?.id !== ctx.me.id) return false;
  const session = await getSession(env.KV, msg.chat.id, panel.message_id);
  if (!session?.awaiting) return false;
  if (!isAdmin(env, msg.chat, msg.from?.id) || session.ownerId !== msg.from?.id) return false;

  const index = fieldIndex(session.awaiting);
  const field = fieldAt(index);
  if (!field) return false;
  await ignoreErrors(ctx.deleteMessage());

  const parsed = parseValue(field, msg.text);
  if (!parsed.ok) {
    await editPanel(ctx, msg.chat.id, panel.message_id, renderAwait(index, parsed.error));
    return true;
  }
  await setOverride(env, field.key, parsed.value);
  await putSession(env.KV, msg.chat.id, panel.message_id, { ownerId: session.ownerId });
  await editPanel(ctx, msg.chat.id, panel.message_id, renderField(await loadConfig(env), index, "✅ 已更新"));
  return true;
}
