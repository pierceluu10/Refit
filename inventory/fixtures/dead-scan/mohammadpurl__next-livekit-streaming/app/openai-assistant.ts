// Excerpt of mohammadpurl/next-livekit-streaming, app/openai-assistant.ts, seen in P5. Nothing imports it.
import OpenAI from "openai";

export class OpenAIAssistant {
  constructor(apiKey) {
    this.client = new OpenAI({ apiKey });
  }

  async initialize() {
    this.assistant = await this.client.beta.assistants.create({
      name: "Tutor",
      model: "gpt-4-turbo-preview",
    });
    this.thread = await this.client.beta.threads.create();
  }
}
