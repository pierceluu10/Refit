// Excerpt of liamstamper/lamp-bot, lib/webhook/groq.ts, seen in P5.
import Groq from "groq-sdk";

export async function runGroqChat(prompt: string, model: string) {
  const reply = await new Groq().chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
  });
  return { content: reply.choices[0].message.content, usage: reply.usage };
}
