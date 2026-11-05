// Excerpt of kousalyaChintha/InfiniteCode, src/components/LeftPanel.jsx, seen in P5.
import { GoogleGenAI } from '@google/genai';

export default function LeftPanel({ aiSettings }) {
  const generate = async (prompt) => {
    const aiClient = new GoogleGenAI({ apiKey: aiSettings.apiKey });
    return aiClient.models.generateContent({
      model: aiSettings.model || 'gemini-2.0-flash',
      contents: prompt,
    });
  };
  return <button onClick={() => generate('x')}>Go</button>;
}
