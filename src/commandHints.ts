import type { CommandContext, Context } from "grammy";
import type { BotCommand } from "grammy/types";
import { isAdmin } from "./configPanel";

/** 群里只提示 /xdjx（chat scope 对所有成员可见）；私聊只有管理员能用，提示管理命令。 */
export function hintCommands(chatType: string): BotCommand[] {
  if (chatType === "private") {
    return [
      { command: "xdjx_config", description: "打开配置面板" },
      { command: "xdjx_hinton", description: "在本聊天注册命令提示" },
      { command: "xdjx_hintoff", description: "移除本聊天的命令提示" },
    ];
  }
  return [{ command: "xdjx", description: "回复一条消息，让 AI 解读（可附加指令）" }];
}

/** /xdjx_hinton、/xdjx_hintoff：在当前 chat 注册 / 移除命令提示（BotCommandScopeChat）。 */
export async function handleHint(ctx: CommandContext<Context>, env: Env, on: boolean): Promise<void> {
  if (!isAdmin(env, ctx.chat, ctx.from?.id)) return;
  const scope = { type: "chat", chat_id: ctx.chat.id } as const;
  let text: string;
  try {
    if (on) await ctx.api.setMyCommands(hintCommands(ctx.chat.type), { scope });
    else await ctx.api.deleteMyCommands({ scope });
    text = on ? "已在本聊天注册命令提示。" : "已移除本聊天的命令提示。";
  } catch (e) {
    console.error("hint failed:", e);
    text = `操作失败：${e instanceof Error ? e.message : String(e)}`;
  }
  await ctx.reply(text, { reply_parameters: { message_id: ctx.msgId!, allow_sending_without_reply: true } });
}
