export type FieldType = "text" | "enum" | "int" | "float" | "idlist";

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: readonly string[];
  /** enum 字段是否允许自定义输入 */
  custom?: boolean;
  min?: number;
  max?: number;
}

export const FIELDS = [
  { key: "ALLOWED_CHAT_IDS", label: "群组白名单", type: "idlist" },
  { key: "SYSTEM_PROMPT", label: "系统提示词", type: "text" },
  {
    key: "MODEL",
    label: "模型",
    type: "enum",
    custom: true,
    options: [
      "gemini-4-argon",
      "gemini-3.8-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-3.1-pro-preview",
    ],
  },
  { key: "THINKING_LEVEL", label: "思考等级", type: "enum", options: ["minimal", "low", "medium", "high"] },
  { key: "MAX_OUTPUT_TOKENS", label: "最大输出 tokens", type: "int", min: 1, max: 65536 },
  { key: "MAX_INPUT_CHARS", label: "最大输入字符数", type: "int", min: 1, max: 100000 },
  { key: "MAX_REPLY_CHARS", label: "最大回复字符数", type: "int", min: 1, max: 40000 },
  { key: "BILLING_CHAT_ID", label: "计费推送 chat", type: "idlist" },
  { key: "PRICE_INPUT_PER_M", label: "输入单价 $/1M", type: "float", min: 0 },
  { key: "PRICE_OUTPUT_PER_M", label: "输出单价 $/1M", type: "float", min: 0 },
  { key: "PRICE_CACHED_PER_M", label: "缓存单价 $/1M", type: "float", min: 0 },
] as const satisfies readonly FieldDef[];

export type Field = (typeof FIELDS)[number] & FieldDef;
export type ConfigKey = Field["key"];
export type RawConfig = Record<ConfigKey, string>;
export type Overrides = Partial<RawConfig>;

export interface Config {
  allowedChatIds: Set<number>;
  systemPrompt: string;
  model: string;
  thinkingLevel: string;
  maxOutputTokens: number;
  maxInputChars: number;
  maxReplyChars: number;
  billingChatIds: number[];
  priceInputPerM: number;
  priceOutputPerM: number;
  priceCachedPerM: number;
}

export interface LoadedConfig {
  config: Config;
  raw: RawConfig;
  defaults: RawConfig;
  overrides: Overrides;
}

const OVERRIDES_KEY = "cfg:overrides";

export function fieldAt(index: number): Field | undefined {
  return FIELDS[index] as Field | undefined;
}

export function fieldIndex(key: ConfigKey): number {
  return FIELDS.findIndex((f) => f.key === key);
}

/** 逗号（含全角）或空白分隔的数字 ID 列表，忽略非法项并去重。 */
export function parseIdList(s: string): number[] {
  const ids = s
    .split(/[\s,，]+/)
    .filter((id) => /^-?\d+$/.test(id))
    .map(Number);
  return [...new Set(ids)];
}

/** 校验并规范化用户输入；"-" 表示清空（仅 idlist）。 */
export function parseValue(field: Field, input: string): { ok: true; value: string } | { ok: false; error: string } {
  const s = input.trim();
  switch (field.type) {
    case "text":
      return s ? { ok: true, value: s } : { ok: false, error: "不能为空" };
    case "enum":
      if (field.options?.includes(s)) return { ok: true, value: s };
      if (field.custom && /^[\w.\-/]{1,64}$/.test(s)) return { ok: true, value: s };
      return { ok: false, error: `可选值：${field.options?.join(", ")}` };
    case "int":
    case "float": {
      const re = field.type === "int" ? /^\d+$/ : /^\d+(\.\d+)?$/;
      const n = Number(s);
      if (!re.test(s) || !Number.isFinite(n)) return { ok: false, error: "请输入有效的非负数字" };
      if (field.min !== undefined && n < field.min) return { ok: false, error: `不能小于 ${field.min}` };
      if (field.max !== undefined && n > field.max) return { ok: false, error: `不能大于 ${field.max}` };
      return { ok: true, value: String(n) };
    }
    case "idlist": {
      if (s === "-" || s === "") return { ok: true, value: "" };
      const ids = s.split(/[\s,，]+/).filter(Boolean);
      if (!ids.every((id) => /^-?\d+$/.test(id))) return { ok: false, error: "请输入以逗号分隔的数字 ID，或 - 清空" };
      return { ok: true, value: [...new Set(ids)].join(",") };
    }
  }
}

function num(value: string, fallback: number): number {
  const n = Number(value);
  return value !== "" && Number.isFinite(n) ? n : fallback;
}

export function resolveConfig(raw: RawConfig): Config {
  return {
    allowedChatIds: new Set(parseIdList(raw.ALLOWED_CHAT_IDS)),
    systemPrompt: raw.SYSTEM_PROMPT,
    model: raw.MODEL || "gemini-4-argon",
    thinkingLevel: raw.THINKING_LEVEL || "low",
    maxOutputTokens: num(raw.MAX_OUTPUT_TOKENS, 2048),
    maxInputChars: num(raw.MAX_INPUT_CHARS, 8000),
    maxReplyChars: num(raw.MAX_REPLY_CHARS, 4000),
    billingChatIds: parseIdList(raw.BILLING_CHAT_ID),
    priceInputPerM: num(raw.PRICE_INPUT_PER_M, 0),
    priceOutputPerM: num(raw.PRICE_OUTPUT_PER_M, 0),
    priceCachedPerM: num(raw.PRICE_CACHED_PER_M, 0),
  };
}

export function defaultsFromEnv(env: Env): RawConfig {
  const vars = env as unknown as Record<string, string | undefined>;
  return Object.fromEntries(FIELDS.map((f) => [f.key, vars[f.key] ?? ""])) as RawConfig;
}

export function mergeConfig(defaults: RawConfig, overrides: Overrides): RawConfig {
  const raw = { ...defaults };
  for (const f of FIELDS) {
    const v = overrides[f.key];
    if (v !== undefined) raw[f.key] = v;
  }
  return raw;
}

export async function loadConfig(env: Env): Promise<LoadedConfig> {
  const overrides = (await env.KV.get<Overrides>(OVERRIDES_KEY, "json")) ?? {};
  const defaults = defaultsFromEnv(env);
  const raw = mergeConfig(defaults, overrides);
  return { config: resolveConfig(raw), raw, defaults, overrides };
}

export async function setOverride(env: Env, key: ConfigKey, value: string | null): Promise<void> {
  const overrides = (await env.KV.get<Overrides>(OVERRIDES_KEY, "json")) ?? {};
  if (value === null) delete overrides[key];
  else overrides[key] = value;
  await env.KV.put(OVERRIDES_KEY, JSON.stringify(overrides));
}

/** ADMIN_USER_ID 支持逗号分隔的多个管理员。 */
export function adminIds(env: Env): Set<number> {
  return new Set(parseIdList(String(env.ADMIN_USER_ID ?? "")));
}
