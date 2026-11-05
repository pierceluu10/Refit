import { describe, expect, it } from 'vitest';
import { loadProvenFixes } from '../toolkit/proven.ts';
import { provenFixes } from './proven.ts';

const [fix] = provenFixes;
const apply = (text: string) => fix.apply(text, 'a.ts');

// Each line is from a real fix on a public repo, measured in evals/rounds/o2.
describe('the gemini-2.0-flash proven fix', () => {
  it('makes the same edit the real fixes made', () => {
    expect(
      apply(
        `const geminiModel = this.configService.get<string>('GEMINI_MODEL') ?? 'gemini-2.0-flash';`,
      ),
    ).toBe(
      `const geminiModel = this.configService.get<string>('GEMINI_MODEL') ?? 'gemini-3.6-flash';`,
    );
    expect(apply(`model: google("gemini-2.0-flash"),`)).toBe(`model: google("gemini-3.6-flash"),`);
    expect(apply('export type Model = "deepseek-chat" | "gemini-2.0-flash";')).toBe(
      'export type Model = "deepseek-chat" | "gemini-3.6-flash";',
    );
  });

  it('leaves a name that only starts the same, and a file with nothing to do', () => {
    expect(apply(`model: "gemini-2.0-flash-lite"`)).toBeUndefined();
    expect(apply(`const m = "gemini-3.6-flash";`)).toBeUndefined();
  });

  it('hands a file that sets sampling or thinking to Claude', () => {
    expect(apply(`model: 'gemini-2.0-flash', temperature: 0.2`)).toBeUndefined();
    expect(apply(`{ model: 'gemini-2.0-flash', topK: 3 }`)).toBeUndefined();
    expect(apply(`model="gemini-2.0-flash", thinking_budget=100`)).toBeUndefined();
  });

  it('is found by its provider and entry, and only when the ladder allows it', async () => {
    expect(await loadProvenFixes(['gemini'], ['gemini-1'])).toHaveLength(1);
    expect(await loadProvenFixes(['gemini'], [])).toEqual([]);
    expect(await loadProvenFixes(['../gemini', 'no-such-provider'], ['gemini-1'])).toEqual([]);
  });
});
