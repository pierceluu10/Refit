// Excerpt of XDTerminated/t2-chat-t3c-2025, src/lib/api/openrouter-api.ts, seen in P5.
export class OpenRouterAPI {
  async generateChatStream(messages, actualModel) {
    return fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: actualModel, messages }),
    });
  }
}
