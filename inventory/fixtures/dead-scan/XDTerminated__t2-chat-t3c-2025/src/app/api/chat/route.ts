// Excerpt of XDTerminated/t2-chat-t3c-2025, src/app/api/chat/route.ts, seen in P5.
import { GeminiAPI, GoogleGeminiAPI } from "~/lib/openrouter";

export async function POST(request) {
  const body = await request.json();
  if (body.image) {
    const geminiApi = new GoogleGeminiAPI(body.geminiApiKey);
    return Response.json(await geminiApi.generateImage(body.prompt));
  }
  const geminiApi = new GeminiAPI(body.geminiApiKey);
  return Response.json(await geminiApi.generateChatStream(body.messages, body.model));
}
