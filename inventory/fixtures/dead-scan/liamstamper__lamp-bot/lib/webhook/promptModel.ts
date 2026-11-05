// Excerpt of liamstamper/lamp-bot, lib/webhook/promptModel.ts, seen in P5.
import { runGroqChat } from "./groq";
import { saveTokenUsage } from "./usage";

export async function runDefaultPrompt(diff: string, ownerGithubId: string) {
  const prompt = `Review this diff:\n\n${diff}`;
  const response = await runGroqChat(prompt, "llama-3.3-70b-versatile");

  await saveTokenUsage({
    userId: ownerGithubId,
    provider: "groq",
    prompt,
    model: "llama-3.3-70b-versatile",
    temperature: 0.2,
    usage: response.usage,
  });
  return response.content;
}
