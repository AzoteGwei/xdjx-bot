import { GoogleGenAI } from "@google/genai";
import type { Config } from "./config";
import type { ImageData } from "./media";

export interface GeminiUsage {
  input: number;
  cached: number;
  output: number;
  thought: number;
  total: number;
}

export interface GeminiResult {
  text: string;
  status: string;
  usage: GeminiUsage;
  interactionId?: string;
}

export interface GeminiRequest {
  texts: string[];
  image?: ImageData;
}

export async function generate(apiKey: string, config: Config, req: GeminiRequest): Promise<GeminiResult> {
  const ai = new GoogleGenAI({ apiKey });
  const input: Array<{ type: "text"; text: string } | { type: "image"; data: string; mime_type: string }> = [];
  if (req.image) input.push({ type: "image", data: req.image.base64, mime_type: req.image.mimeType });
  for (const text of req.texts) input.push({ type: "text", text });

  const interaction = await ai.interactions.create({
    model: config.model,
    input,
    system_instruction: config.systemPrompt || undefined,
    store: false,
    generation_config: {
      max_output_tokens: config.maxOutputTokens,
      thinking_level: config.thinkingLevel,
    },
  });

  const u = interaction.usage;
  return {
    text: interaction.output_text ?? "",
    status: interaction.status ?? "unknown",
    interactionId: interaction.id,
    usage: {
      input: u?.total_input_tokens ?? 0,
      cached: u?.total_cached_tokens ?? 0,
      output: u?.total_output_tokens ?? 0,
      thought: u?.total_thought_tokens ?? 0,
      total: u?.total_tokens ?? 0,
    },
  };
}
