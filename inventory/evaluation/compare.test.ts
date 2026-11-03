import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApiUsage } from '../../shared/types.ts';
import type { InventoryReport } from '../agent.ts';
import { compareRuns, sameProvider } from './compare.ts';

const usage = (
  provider: string,
  via: ApiUsage['via'],
  extra: Partial<ApiUsage> = {},
): ApiUsage => ({
  repo: 'acme/app',
  provider,
  via,
  callSites: [],
  ...extra,
});

describe('compareRuns', () => {
  it('matches a provider by id, by containment, by SDK within a family, or by a shared host', () => {
    expect(sameProvider(usage('OpenAI', 'sdk'), usage('openai', 'sdk'))).toBe(true);
    expect(sameProvider(usage('firebase-firestore', 'sdk'), usage('firebase', 'sdk'))).toBe(true);
    expect(
      sameProvider(
        usage('google-vertex-ai', 'sdk', { sdk: { name: '@google-cloud/vertexai', version: '1' } }),
        usage('google-cloud-vertexai', 'sdk', {
          sdk: { name: '@google-cloud/vertexai', version: '1' },
        }),
      ),
    ).toBe(true);
    expect(
      sameProvider(
        usage('deepseek', 'sdk', { hints: { hosts: ['api.deepseek.com'] } }),
        usage('api.deepseek.com', 'sdk', { hints: { hosts: ['api.deepseek.com'] } }),
      ),
    ).toBe(true);
    // The same SDK across vendors (OpenAI-compatible providers) is not the same provider.
    expect(
      sameProvider(
        usage('groq', 'sdk', { sdk: { name: 'openai', version: '4' } }),
        usage('openai', 'sdk', { sdk: { name: 'openai', version: '4' } }),
      ),
    ).toBe(false);
  });

  it('counts a usage found only with the same channel', () => {
    const result = compareRuns(
      { usages: [usage('stripe', 'sdk'), usage('stripe', 'webhook'), usage('raynet', 'http')] },
      { usages: [usage('stripe', 'sdk'), usage('raynet', 'http'), usage('resend', 'sdk')] },
    );
    expect(result.found).toBe(2);
    expect(result.missing.map((found) => `${found.provider}|${found.via}`)).toEqual([
      'stripe|webhook',
    ]);
    expect(result.extra.map((found) => found.provider)).toEqual(['resend']);
  });

  it('reproduces the round 3 measurement from the saved reports', async () => {
    const dir = path.join(import.meta.dirname, 'round-3');
    const read = async (folder: string, name: string) =>
      JSON.parse(await readFile(path.join(dir, folder, name), 'utf8')) as InventoryReport;
    const names = [
      '4lbatr0s__jiro.json',
      'adamhitzger__financehb.json',
      'alanagoyal__branded.json',
      'borodinka__hire-wise.json',
      'crlny__lobe-chat.json',
      'guixincui__LobeChat.json',
      'mohammadpurl__next-livekit-streaming.json',
      'ravi-aman__pureFeedback.json',
    ];
    let found = 0;
    let total = 0;
    let oldUsd = 0;
    let newUsd = 0;
    for (const name of names) {
      const [old, fresh] = await Promise.all([read('old', name), read('new', name)]);
      found += compareRuns(old, fresh).found;
      total += old.usages.length;
      oldUsd += old.costUsd;
      newUsd += fresh.costUsd;
    }
    expect({ found, total }).toEqual({ found: 126, total: 131 });
    expect(oldUsd).toBeCloseTo(1.4062, 3);
    expect(newUsd).toBeCloseTo(0.696, 3);
    // The old inventory against itself on lobe-chat, for scale.
    const [first, second] = await Promise.all([
      read('old', 'crlny__lobe-chat.json'),
      read('old-rerun', 'crlny__lobe-chat.json'),
    ]);
    expect(compareRuns(first, second).found).toBe(72);
  });
});
