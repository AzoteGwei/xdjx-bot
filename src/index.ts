import { webhookCallback } from "grammy";
import { createBot } from "./bot";
import { deriveWebhookSecret } from "./webhook";

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== "POST") return new Response("ok");
    const secretToken = await deriveWebhookSecret(env.BOT_TOKEN);
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secretToken) {
      return new Response("unauthorized", { status: 401 });
    }
    const bot = await createBot(env);
    return webhookCallback(bot, "cloudflare-mod", {
      secretToken,
      onTimeout: "return",
      timeoutMilliseconds: 90_000,
    })(request);
  },
} satisfies ExportedHandler<Env>;
