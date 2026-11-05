// Excerpt of mohammadpurl/next-livekit-streaming, app/api/chat/route.ts, seen in P5.
import OpenAI from "openai";
const openai = new OpenAI();

export async function POST() {
  const assistant = await openai.beta.assistants.create({
    name: "Tutor",
    model: "gpt-4-turbo-preview",
  });
  return Response.json(assistant);
}
