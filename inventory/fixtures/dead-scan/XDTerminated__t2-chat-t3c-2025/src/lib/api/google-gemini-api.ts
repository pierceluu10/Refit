// Excerpt of XDTerminated/t2-chat-t3c-2025, src/lib/api/google-gemini-api.ts, seen in P5.
export class GoogleGeminiAPI {
  private baseUrl = "https://generativelanguage.googleapis.com";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async generateImage(
    prompt: string,
    _model = "gemini-2.0-flash-preview-image-generation",
  ): Promise<{ data: Array<{ url: string }> }> {
    const response = await fetch(
      `${this.baseUrl}/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${this.apiKey}`,
      { method: "POST", body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) },
    );
    return response.json();
  }
}
