// Excerpt of liamstamper/lamp-bot, lib/webhook/usage.ts, seen in P5.
export async function saveTokenUsage(row: Record<string, unknown>) {
  return fetch("/api/usage", { method: "POST", body: JSON.stringify(row) });
}
