import { describe, expect, it } from 'vitest';
import { provenFixes } from './proven.ts';

const [fix] = provenFixes;

// From real fixes on public repos, measured in evals/rounds/o2 and o3.
describe('the gpt-3.5-turbo proven fix', () => {
  it('makes the same edit the real fixes made', () => {
    const before = `const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    temperature: 0,
    stream: true,
`;
    expect(fix.apply(before, 'route.ts'))
      .toBe(`const response = await openai.chat.completions.create({
    model: "gpt-5.6-terra",
    stream: true,
`);
  });

  it('takes out a temperature line that carries a comment', () => {
    const before = `model: "gpt-3.5-turbo",
      temperature: 0.7, // Adjust the temperature as needed
      stream: true,
`;
    expect(fix.apply(before, 'route.ts')).toBe(`model: "gpt-5.6-terra",
      stream: true,
`);
  });

  it('leaves a longer name alone', () => {
    expect(fix.apply(`model: "gpt-3.5-turbo-instruct",`, 'a.ts')).toBeUndefined();
  });

  it('hands fine-tuning and other settings to Claude', () => {
    expect(
      fix.apply(`client.fineTuning.jobs.create({ model: 'gpt-3.5-turbo' })`, 'a.ts'),
    ).toBeUndefined();
    expect(fix.apply(`{ model: 'gpt-3.5-turbo', top_p: 1 }`, 'a.ts')).toBeUndefined();
  });
});
