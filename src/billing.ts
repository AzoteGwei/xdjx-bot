import type { Api } from "grammy";
import type { Config } from "./config";
import type { GeminiUsage } from "./gemini";
import { ignoreErrors, splitText } from "./telegram";

const TOTAL_KEY = "bill:total";

export interface BillingTotals {
  calls: number;
  input: number;
  output: number;
  cost: number;
  since: string;
}

/** thinking tokens 按输出价计费；缓存命中部分按缓存价计费。 */
export function estimateCost(usage: GeminiUsage, config: Config): number {
  const uncached = Math.max(0, usage.input - usage.cached);
  return (
    (uncached * config.priceInputPerM +
      usage.cached * config.priceCachedPerM +
      (usage.output + usage.thought) * config.priceOutputPerM) /
    1e6
  );
}

export async function getTotals(kv: KVNamespace): Promise<BillingTotals> {
  return (
    (await kv.get<BillingTotals>(TOTAL_KEY, "json")) ?? {
      calls: 0,
      input: 0,
      output: 0,
      cost: 0,
      since: new Date().toISOString(),
    }
  );
}

export async function resetTotals(kv: KVNamespace): Promise<void> {
  await kv.delete(TOTAL_KEY);
}

export async function addToTotals(kv: KVNamespace, usage: GeminiUsage, cost: number): Promise<BillingTotals> {
  const t = await getTotals(kv);
  t.calls += 1;
  t.input += usage.input;
  t.output += usage.output + usage.thought;
  t.cost += cost;
  await kv.put(TOTAL_KEY, JSON.stringify(t));
  return t;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n !== 0 && n < 0.01 ? 6 : 4)}`;
}

export interface BillingLog {
  chat: { id: number; title?: string };
  user: { id: number; name: string; username?: string };
  targetMessageId: number;
  model: string;
  thinkingLevel: string;
  inputChars: number;
  instructionChars: number;
  image?: { mimeType: string; bytes: number };
  durationMs: number;
  status: string;
  usage?: GeminiUsage;
  cost?: number;
  totals?: BillingTotals;
  replyChars?: number;
  error?: string;
}

export function formatBillingLog(log: BillingLog): string {
  const lines = [
    `🧾 /xdjx ${log.error ? "❌ 失败" : "✅ 完成"}`,
    `时间：${new Date().toISOString()}`,
    `群组：${log.chat.title ?? ""} (${log.chat.id})`,
    `用户：${log.user.name}${log.user.username ? ` @${log.user.username}` : ""} (${log.user.id})`,
    `目标消息：${log.targetMessageId}`,
    `模型：${log.model} · thinking=${log.thinkingLevel}`,
    `输入：文字 ${log.inputChars} 字符 · 指令 ${log.instructionChars} 字符 · 图片 ${
      log.image ? `${log.image.mimeType} ${(log.image.bytes / 1024).toFixed(1)}KB` : "无"
    }`,
    `状态：${log.status} · 耗时 ${(log.durationMs / 1000).toFixed(2)}s`,
  ];
  if (log.usage) {
    const u = log.usage;
    lines.push(
      `Tokens：input ${u.input} (cached ${u.cached}) · output ${u.output} · thought ${u.thought} · total ${u.total}`,
    );
  }
  if (log.cost !== undefined) lines.push(`预估成本：${formatUsd(log.cost)}`);
  if (log.replyChars !== undefined) lines.push(`回复长度：${log.replyChars} 字符`);
  if (log.totals) {
    lines.push(
      `累计：${log.totals.calls} 次 · in ${log.totals.input} · out ${log.totals.output} · ${formatUsd(log.totals.cost)}（自 ${log.totals.since.slice(0, 10)}）`,
    );
  }
  if (log.error) lines.push(`错误：${log.error}`);
  return lines.join("\n");
}

export async function pushBillingLog(api: Api, config: Config, log: BillingLog): Promise<void> {
  if (config.billingChatId === null) return;
  for (const chunk of splitText(formatBillingLog(log), 8000)) {
    await ignoreErrors(api.sendMessage(config.billingChatId, chunk, { link_preview_options: { is_disabled: true } }));
  }
}
