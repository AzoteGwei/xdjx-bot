export const TG_TEXT_LIMIT = 4096;

/** 截断到 maxChars 后按 Telegram 单条上限分片，尽量在换行处切分。 */
export function splitText(text: string, maxChars: number, limit = TG_TEXT_LIMIT): string[] {
  let body = text;
  if (body.length > maxChars) body = `${body.slice(0, Math.max(0, maxChars - 8)).trimEnd()}\n…（已截断）`;
  const chunks: string[] = [];
  while (body.length > limit) {
    let cut = body.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(body.slice(0, cut));
    body = body.slice(cut).replace(/^\n/, "");
  }
  if (body) chunks.push(body);
  return chunks;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** 忽略失败（权限不足、消息已删除、内容未变化等）。 */
export async function ignoreErrors<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    console.warn("ignored telegram error:", e instanceof Error ? e.message : e);
    return undefined;
  }
}
