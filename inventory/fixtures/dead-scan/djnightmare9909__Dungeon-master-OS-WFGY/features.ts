// Excerpt of djnightmare9909/Dungeon-master-OS-WFGY, features.ts, seen in P5.
import { ai } from './gemini';
import { retryOperation } from './utils';

export const draw = (imagePrompt: string) =>
  retryOperation(() => ai.models.generateImages({
    model: 'imagen-4.0-generate-001',
    prompt: imagePrompt,
  }));
