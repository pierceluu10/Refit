// Excerpt of liamstamper/lamp-bot, app/api/prompts/test/route.ts, seen in P5.
import Groq from "groq-sdk";

export async function POST(request: Request) {
  const { fullPrompt, model } = await request.json();
  const groq = new Groq();
  const reply = await groq.chat.completions.create({
    model,
    messages: [{ role: "user", content: fullPrompt }],
  });
  return Response.json(reply);
}
