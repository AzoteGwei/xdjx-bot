import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { estimateCost } from "../src/billing";
import { FIELDS, fieldAt, mergeConfig, parseValue, resolveConfig, type LoadedConfig, type RawConfig } from "../src/config";
import { hintCommands } from "../src/commandHints";
import { isAdmin, renderAwait, renderField, renderHome } from "../src/configPanel";
import { extractImage } from "../src/media";
import { splitText } from "../src/telegram";
import { deriveWebhookSecret } from "../src/webhook";
import { buildPrompt, formatSources } from "../src/xdjx";

const defaults: RawConfig = {
  ALLOWED_CHAT_IDS: "-1001,-1002",
  SYSTEM_PROMPT: "sys",
  MODEL: "gemini-4-argon",
  THINKING_LEVEL: "low",
  GOOGLE_SEARCH: "off",
  MAX_OUTPUT_TOKENS: "2048",
  MAX_INPUT_CHARS: "8000",
  MAX_REPLY_CHARS: "4000",
  BILLING_CHAT_ID: "",
  PRICE_INPUT_PER_M: "2",
  PRICE_OUTPUT_PER_M: "10",
  PRICE_CACHED_PER_M: "0.1",
  PRICE_SEARCH_PER_K: "14",
};

const field = (key: string) => fieldAt(FIELDS.findIndex((f) => f.key === key))!;

describe("config", () => {
  it("merges overrides over defaults and resolves types", () => {
    const raw = mergeConfig(defaults, { MODEL: "gemini-3.8-flash", BILLING_CHAT_ID: "-42" });
    const cfg = resolveConfig(raw);
    expect(cfg.model).toBe("gemini-3.8-flash");
    expect(cfg.billingChatIds).toEqual([-42]);
    expect(cfg.allowedChatIds.has(-1002)).toBe(true);
    expect(cfg.maxOutputTokens).toBe(2048);
    expect(resolveConfig(defaults).billingChatIds).toEqual([]);
    expect(resolveConfig({ ...defaults, ALLOWED_CHAT_IDS: "-1，-2, x" }).allowedChatIds).toEqual(new Set([-1, -2]));
  });

  it("validates input per field type", () => {
    expect(parseValue(field("MAX_OUTPUT_TOKENS"), "abc").ok).toBe(false);
    expect(parseValue(field("MAX_OUTPUT_TOKENS"), "0").ok).toBe(false);
    expect(parseValue(field("MAX_OUTPUT_TOKENS"), " 4096 ")).toEqual({ ok: true, value: "4096" });
    expect(parseValue(field("PRICE_INPUT_PER_M"), "0.30")).toEqual({ ok: true, value: "0.3" });
    expect(parseValue(field("ALLOWED_CHAT_IDS"), "-1, -2，-2 -3")).toEqual({ ok: true, value: "-1,-2,-3" });
    expect(parseValue(field("ALLOWED_CHAT_IDS"), "-")).toEqual({ ok: true, value: "" });
    expect(parseValue(field("ALLOWED_CHAT_IDS"), "abc").ok).toBe(false);
    expect(parseValue(field("BILLING_CHAT_ID"), "-100123, 5")).toEqual({ ok: true, value: "-100123,5" });
    expect(parseValue(field("MODEL"), "my-model-1.0")).toEqual({ ok: true, value: "my-model-1.0" });
    expect(parseValue(field("THINKING_LEVEL"), "ultra").ok).toBe(false);
    expect(parseValue(field("SYSTEM_PROMPT"), "  ").ok).toBe(false);
  });
});

describe("billing", () => {
  it("charges cached at cached rate and thinking at output rate", () => {
    const cfg = resolveConfig(defaults);
    const cost = estimateCost({ input: 1_000_000, cached: 500_000, output: 100_000, thought: 100_000, total: 0, searches: 0 }, cfg);
    expect(cost).toBeCloseTo(0.5 * 2 + 0.5 * 0.1 + 0.2 * 10);
    const search = estimateCost({ input: 0, cached: 0, output: 0, thought: 0, total: 0, searches: 2 }, cfg);
    expect(search).toBeCloseTo(0.028);
    expect(resolveConfig(defaults).googleSearch).toBe(false);
    expect(resolveConfig({ ...defaults, GOOGLE_SEARCH: "on" }).googleSearch).toBe(true);
  });
});

describe("splitText", () => {
  it("truncates to maxChars and splits under the Telegram limit", () => {
    const chunks = splitText("a".repeat(10_000), 9000);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
    expect(chunks.join("").length).toBeLessThanOrEqual(9000);
    expect(chunks.at(-1)).toContain("已截断");
    expect(splitText("hi", 4000)).toEqual(["hi"]);
  });
});

describe("media", () => {
  it("picks the largest photo, image documents and static stickers", () => {
    const base = { message_id: 1, date: 0, chat: { id: 1, type: "group", title: "g" } } as const;
    const photo = { ...base, photo: [{ file_id: "s", file_unique_id: "s", width: 1, height: 1 }, { file_id: "l", file_unique_id: "l", width: 9, height: 9 }] } as Message;
    expect(extractImage(photo)?.fileId).toBe("l");
    const doc = { ...base, document: { file_id: "d", file_unique_id: "d", mime_type: "image/png" } } as Message;
    expect(extractImage(doc)).toMatchObject({ fileId: "d", mimeType: "image/png" });
    const pdf = { ...base, document: { file_id: "p", file_unique_id: "p", mime_type: "application/pdf" } } as Message;
    expect(extractImage(pdf)).toBeNull();
    const anim = { ...base, sticker: { file_id: "a", is_animated: true, is_video: false } } as unknown as Message;
    expect(extractImage(anim)).toBeNull();
  });

  it("builds prompt parts from text, quote and instruction", () => {
    const msg = { message_id: 1, date: 0, chat: { id: 1, type: "group" }, text: "hello", from: { id: 2, is_bot: false, first_name: "A" } } as Message;
    const { texts, inputChars } = buildPrompt(msg, "hel", "翻译", 3);
    expect(inputChars).toBe(3);
    expect(texts).toHaveLength(3);
    expect(texts[2]).toContain("翻译");
  });

  it("formats sources as linked domains", () => {
    expect(formatSources([])).toBeUndefined();
    const many = Array.from({ length: 7 }, (_, i) => ({ url: `https://r.example/${i}`, title: i ? `site${i}.com` : undefined }));
    const footer = formatSources(many)!;
    expect(footer.text).toBe("来源：r.example · site1.com · site2.com · site3.com · site4.com");
    expect(footer.entities).toHaveLength(5);
    const [first, second] = footer.entities as Array<{ offset: number; length: number; url: string }>;
    expect(footer.text.slice(first!.offset, first!.offset + first!.length)).toBe("r.example");
    expect(footer.text.slice(second!.offset, second!.offset + second!.length)).toBe("site1.com");
    expect(second!.url).toBe("https://r.example/1");
  });
});

describe("config panel", () => {
  const env = { ADMIN_USER_ID: "42" } as unknown as Env;
  const loaded: LoadedConfig = {
    raw: mergeConfig(defaults, { MODEL: "gemini-3.8-flash" }),
    defaults,
    overrides: { MODEL: "gemini-3.8-flash" },
    config: resolveConfig(defaults),
  };

  it("checks chat id in private chats and user id in groups", () => {
    expect(isAdmin(env, { id: 42, type: "private" }, 42)).toBe(true);
    expect(isAdmin(env, { id: 7, type: "private" }, 7)).toBe(false);
    expect(isAdmin(env, { id: -100, type: "supergroup" }, 42)).toBe(true);
    expect(isAdmin(env, { id: -100, type: "supergroup" }, 7)).toBe(false);
    expect(isAdmin({ ADMIN_USER_ID: "" } as unknown as Env, { id: 42, type: "private" }, 42)).toBe(false);
    const multi = { ADMIN_USER_ID: "42, 43" } as unknown as Env;
    expect(isAdmin(multi, { id: 43, type: "private" }, 43)).toBe(true);
    expect(isAdmin(multi, { id: -100, type: "supergroup" }, 43)).toBe(true);
    expect(isAdmin(multi, { id: -100, type: "supergroup" }, undefined)).toBe(false);
  });

  it("keeps callback data within 64 bytes and marks overrides", () => {
    const views = [renderHome(loaded), ...FIELDS.map((_, i) => renderField(loaded, i)), renderAwait(0, "bad")];
    for (const v of views) {
      for (const row of v.keyboard.inline_keyboard) {
        for (const btn of row) {
          if ("callback_data" in btn) expect(new TextEncoder().encode(btn.callback_data).length).toBeLessThanOrEqual(64);
        }
      }
    }
    const home = renderHome(loaded).keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(home.find((t) => t.startsWith("模型"))).toContain("✎");
    expect(renderField(loaded, 2).text).toContain("默认值");
  });
});

describe("command hints", () => {
  it("only hints /xdjx in groups and admin commands in private chats", () => {
    expect(hintCommands("supergroup").map((c) => c.command)).toEqual(["xdjx"]);
    expect(hintCommands("private").map((c) => c.command)).toContain("xdjx_config");
    for (const c of [...hintCommands("group"), ...hintCommands("private")]) expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
  });
});

describe("webhook secret", () => {
  it("is deterministic and valid for Telegram", async () => {
    const s = await deriveWebhookSecret("123:abc");
    expect(s).toMatch(/^[0-9a-f]{32}$/);
    expect(await deriveWebhookSecret("123:abc")).toBe(s);
  });
});
