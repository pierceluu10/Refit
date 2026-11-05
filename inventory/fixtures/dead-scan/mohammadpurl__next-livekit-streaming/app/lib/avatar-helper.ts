// A helper in app/ that a page's code imports, so it runs although Next.js doesn't serve it. Made for P5 from the shape of mohammadpurl/next-livekit-streaming.
import OpenAI from "openai";
const openai = new OpenAI();
export const avatarHelper = () =>
  openai.chat.completions.create({ model: "gpt-4-turbo-preview", messages: [] });
