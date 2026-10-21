import { GrammyError, type Api } from "grammy";
import { splitText, TG_TEXT_LIMIT } from "./telegram";

/** 群聊每分钟约 20 条消息/编辑的限额，按 3s 节流。 */
const EDIT_INTERVAL_MS = 3000;
const CURSOR = " ▍";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 以“发送 + 不断编辑”的方式把流式文本呈现为一组回复消息。
 * 超过单条上限时自动续发新消息；遇到 429 按 retry_after 退避。
 */
export class StreamingReply {
  private readonly sent: Array<{ id: number; text: string }> = [];
  private nextAt = 0;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly replyTo: number,
    private readonly maxChars: number,
  ) {}

  get started(): boolean {
    return this.sent.length > 0;
  }

  /** 流式过程中调用；未到节流时间则跳过。 */
  async update(text: string): Promise<void> {
    if (Date.now() < this.nextAt) return;
    await this.render(text, false);
  }

  /** 最终渲染，必须送达；返回实际发出的字符数。 */
  async finish(text: string): Promise<number> {
    const wait = this.nextAt - Date.now();
    if (wait > 0) await sleep(wait);
    return this.render(text, true);
  }

  private async render(text: string, final: boolean): Promise<number> {
    const chunks = splitText(text, this.maxChars, TG_TEXT_LIMIT - CURSOR.length);
    if (!final && chunks.length > 0) chunks[chunks.length - 1] += CURSOR;
    try {
      for (const [i, chunk] of chunks.entries()) {
        const prev = this.sent[i];
        if (prev?.text === chunk) continue;
        if (prev) {
          await this.call(final, () =>
            this.api
              .editMessageText(this.chatId, prev.id, chunk, { link_preview_options: { is_disabled: true } })
              .catch((e) => {
                // Telegram 会裁剪首尾空白，可能判定为内容未变化
                if (!(e instanceof GrammyError && e.description.includes("message is not modified"))) throw e;
              }),
          );
          prev.text = chunk;
        } else {
          const msg = await this.call(final, () =>
            this.api.sendMessage(this.chatId, chunk, {
              reply_parameters: { message_id: this.replyTo, allow_sending_without_reply: true },
              link_preview_options: { is_disabled: true },
            }),
          );
          this.sent.push({ id: msg.message_id, text: chunk });
        }
      }
    } catch (e) {
      if (final) throw e;
      console.warn("stream render skipped:", e instanceof Error ? e.message : e);
    }
    this.nextAt = Math.max(this.nextAt, Date.now() + EDIT_INTERVAL_MS);
    return chunks.reduce((n, c) => n + c.length, 0);
  }

  /** 429 时记录退避时间；final 模式下等待后重试一次。 */
  private async call<T>(final: boolean, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof GrammyError && e.error_code === 429)) throw e;
      const ms = (e.parameters.retry_after ?? 3) * 1000;
      this.nextAt = Date.now() + ms;
      if (!final) throw e;
      await sleep(ms);
      return fn();
    }
  }
}
