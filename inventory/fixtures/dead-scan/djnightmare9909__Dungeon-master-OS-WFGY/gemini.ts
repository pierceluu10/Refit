// Excerpt of djnightmare9909/Dungeon-master-OS-WFGY, gemini.ts, seen in P5.
import { GoogleGenAI } from '@google/genai';

let _ai: GoogleGenAI | undefined;
export const ai = new Proxy({}, {
  get(target, prop) {
    if (prop === 'models') {
      return {
        generateContent: async (params: any) => {
          if (!_ai) _ai = new GoogleGenAI({ apiKey: getApiKey() });
          return _ai.models.generateContent(params);
        },
      };
    }
    return undefined;
  },
}) as any;
