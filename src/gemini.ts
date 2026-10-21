import { GoogleGenAI } from "@google/genai";
import type { Config } from "./config";
import type { ImageData } from "./media";

export interface GeminiUsage {
  input: number;
  cached: number;
  output: number;
  thought: number;
  total: number;
  /** Google Search 调用次数（按次计费） */
  searches: number;
}

export interface Citation {
  url: string;
  title?: string;
}

export interface GeminiResult {
  text: string;
  status: string;
  usage: GeminiUsage;
  citations: Citation[];
  interactionId?: string;
}

export interface GeminiRequest {
  texts: string[];
  image?: ImageData;
}

interface RawUsage {
  total_input_tokens?: number;
  total_cached_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  total_tokens?: number;
  grounding_tool_count?: Array<{ type?: string; count?: number }>;
}

function toUsage(u: RawUsage | undefined): GeminiUsage {
  return {
    input: u?.total_input_tokens ?? 0,
    cached: u?.total_cached_tokens ?? 0,
    output: u?.total_output_tokens ?? 0,
    thought: u?.total_thought_tokens ?? 0,
    total: u?.total_tokens ?? 0,
    searches: (u?.grounding_tool_count ?? [])
      .filter((g) => g.type === "google_search")
      .reduce((n, g) => n + (g.count ?? 0), 0),
  };
}

/** 流式生成；每收到一段文本就以累计全文回调 onText（会被 await，可用于节流编辑消息）。 */
export async function generateStream(
  apiKey: string,
  config: Config,
  req: GeminiRequest,
  onText: (text: string) => Promise<void>,
): Promise<GeminiResult> {
  const ai = new GoogleGenAI({ apiKey });
  const input: Array<{ type: "text"; text: string } | { type: "image"; data: string; mime_type: string }> = [];
  if (req.image) input.push({ type: "image", data: req.image.base64, mime_type: req.image.mimeType });
  for (const text of req.texts) input.push({ type: "text", text });

  const stream = await ai.interactions.create({
    model: config.model,
    input,
    system_instruction: config.systemPrompt || undefined,
    tools: config.googleSearch ? [{ type: "google_search" }] : undefined,
    store: false,
    stream: true,
    generation_config: {
      max_output_tokens: config.maxOutputTokens,
      thinking_level: config.thinkingLevel,
    },
  });

  let text = "";
  let status = "unknown";
  let usage: RawUsage | undefined;
  let interactionId: string | undefined;
  const citations = new Map<string, Citation>();
  for await (const event of stream) {
    switch (event.event_type) {
      case "interaction.created":
        interactionId = event.interaction.id;
        break;
      case "step.delta":
        if (event.metadata?.total_usage) usage = event.metadata.total_usage;
        if (event.delta.type === "text" && event.delta.text) {
          text += event.delta.text;
          await onText(text);
        }
        if (event.delta.type === "text_annotation_delta") {
          for (const a of event.delta.annotations ?? []) {
            if (a.type === "url_citation" && a.url && !citations.has(a.url)) citations.set(a.url, { url: a.url, title: a.title });
          }
        }
        break;
      case "step.stop":
        if (event.usage) usage = event.usage;
        break;
      case "interaction.status_update":
        status = event.status;
        if (event.usage) usage = event.usage;
        break;
      case "interaction.completed":
        interactionId = event.interaction.id;
        status = event.interaction.status;
        if (event.interaction.usage) usage = event.interaction.usage;
        break;
      case "error":
        throw new Error(`Gemini stream error: ${event.error?.code ?? ""} ${event.error?.message ?? ""}`.trim());
    }
  }
  return { text, status, interactionId, usage: toUsage(usage), citations: [...citations.values()] };
}
