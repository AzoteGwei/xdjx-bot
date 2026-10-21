/** 由 BOT_TOKEN 派生 webhook secret_token，避免额外的 secret。 */
export async function deriveWebhookSecret(botToken: string): Promise<string> {
  const data = new TextEncoder().encode(`xdjx-webhook:${botToken}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
