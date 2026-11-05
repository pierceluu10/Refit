// Excerpt of XDTerminated/t2-chat-t3c-2025, src/lib/api/gemini-api.ts, seen in P5.
import { GoogleGenerativeAI } from "@google/generative-ai";

export class GeminiAPI {
  constructor(apiKey) {
    this.legacyGenAI = new GoogleGenerativeAI(apiKey);
  }

  async generateChatStream(messages, modelId) {
    return this.legacyGenAI.getGenerativeModel({ model: modelId }).generateContentStream(messages);
  }

  async generateImage(
    prompt: string,
    _model = "gemini-2.0-flash-preview-image-generation",
    _options?: {
      numberOfImages?: number;
      aspectRatio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
    },
  ): Promise<{ data: Array<{ url: string }> }> {
    const model = this.legacyGenAI.getGenerativeModel({
      model: "gemini-2.0-flash-preview-image-generation",
    });
    return model.generateContent([{ text: prompt }]);
  }
}
