// Excerpt of swharr/TrailblazerAI, src/app/admin/page.tsx, seen in P5.
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export const clients = { OpenAI, Anthropic };

export default function Admin({ getProviderValue, updateProviderEdit }) {
  return (
    <>
      <Select
        value={getProviderValue('anthropic', 'defaultModel') ?? 'claude-sonnet-4-20250514'}
        onValueChange={(v) => updateProviderEdit('anthropic', 'defaultModel', v)}
      >
        <SelectItem value="claude-sonnet-4-20250514">Claude Sonnet 4 (Recommended)</SelectItem>
      </Select>
      <Select onValueChange={(v) => updateProviderEdit('openai', 'defaultModel', v)}>
        <SelectItem value="o1">o1 (Reasoning)</SelectItem>
        <SelectItem value="o1-mini">o1 Mini</SelectItem>
        <SelectItem value="o1-mini-2024-09-12">o1 Mini (Sep 2024)</SelectItem>
      </Select>
    </>
  );
}
