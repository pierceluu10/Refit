import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeadlineRegistry } from './deadline-registry.ts';
import { loadMetaGraphChanges } from './meta-graph-changes.ts';
import { loadMetaPlatformAlerts, planMetaGraphFixes } from './meta-graph-fixes.ts';
import { loadMetaGraphRules } from './meta-graph-rule-edits.ts';

const NOW = new Date('2026-10-29T12:00:00Z');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-meta-graph-fixes-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

const registry: DeadlineRegistry = { formatVersion: 1, deadlines: [] };

async function plan(files: Record<string, string>) {
  return planMetaGraphFixes(
    await directory({ 'package.json': '{"name":"app"}', ...files }),
    'v25.0',
    {
      changes: await loadMetaGraphChanges(undefined, NOW),
      registry,
      rules: [],
      alerts: await loadMetaPlatformAlerts(),
      now: NOW,
    },
  );
}

describe('Meta Graph fix plans', () => {
  it('lists Instagram Basic Display use as a migration with the documented plan', async () => {
    const result = await plan({
      'page.tsx': `export const href = 'https://api.instagram.com/oauth/authorize?client_id=1&scope=user_profile,user_media&response_type=code';`,
      'me.ts': `export const me = (token: string) => fetch(\`https://graph.instagram.com/me?fields=id,username&access_token=\${token}\`);`,
    });
    expect(result.migrations).toMatchObject([
      {
        product: 'instagram-basic-display',
        uses: [{ file: 'page.tsx', line: 1, evidence: 'requests user_profile, user_media' }],
      },
    ]);
    expect(result.migrations[0].plan[0]).toContain('2024-12-04');
    expect(result.alerts).toMatchObject([
      {
        alert: 'instagram-basic-display-api-shutdown',
        effective: '2024-12-04',
        status: 'in-effect',
        file: 'page.tsx',
      },
    ]);
  });

  it('alerts on a WhatsApp On-Premises API client, which Meta shut down, and never edits it', async () => {
    const result = await plan({
      'whatsapp.ts': `// WhatsApp Business API client on our own host.
export const login = (host: string) => fetch(\`\${host}/v1/users/login\`, { method: 'POST' });`,
      'other.ts': `export const login = (host: string) => fetch(\`\${host}/v1/users/login\`);`,
    });
    expect(result.migrations).toMatchObject([
      {
        product: 'whatsapp-on-premises',
        uses: [{ file: 'whatsapp.ts', line: 2, evidence: 'calls /v1/users/login' }],
      },
    ]);
    expect(result.alerts).toMatchObject([
      {
        alert: 'whatsapp-on-premises-api-shutdown',
        effective: '2025-10-23',
        file: 'whatsapp.ts',
        replacement: ['WhatsApp Cloud API'],
      },
    ]);
    expect(result.proposal.edits).toEqual([]);
  });

  it('alerts on retired permissions, insights metrics and oEmbed requests, never in tests', async () => {
    const result = await plan({
      'login.ts': `FB.login(done, { scope: 'email,manage_pages,publish_pages' });`,
      'insights.ts': `export const read = (id: string) => fetch(\`https://graph.facebook.com/v22.0/\${id}/insights?metric=page_impressions,page_follows\`);`,
      'embed.ts': `export const embed = (url: string) => fetch(\`https://graph.facebook.com/v22.0/instagram_oembed?url=\${url}\`);`,
      'login.test.ts': `FB.login(done, { scope: 'manage_pages' });`,
    });
    expect(result.alerts.map((hit) => [hit.alert, hit.file, hit.matched, hit.status])).toEqual([
      ['facebook-manage-pages-replaced', 'login.ts', 'manage_pages', 'undated'],
      ['facebook-publish-pages-replaced', 'login.ts', 'publish_pages', 'undated'],
      ['meta-oembed-read-replacement', 'embed.ts', '/instagram_oembed', 'in-effect'],
      ['facebook-page-insights-metrics-2025-11-15', 'insights.ts', 'page_impressions', 'in-effect'],
    ]);
    expect(result.alerts[0].replacement).toContain('pages_read_engagement');
  });
});

describe('out-of-cycle changes', () => {
  it('scopes a field change to its endpoint and never guesses parameter values', async () => {
    const result = await plan({
      'media.ts': `export const media = (id: string) => fetch(\`https://graph.facebook.com/v22.0/\${id}/media?fields=id,thumbnail_url\`);
export const carousel = (id: string) => fetch(\`https://graph.facebook.com/v22.0/\${id}/media\`, { method: 'POST', body: JSON.stringify({ media_type: 'CAROUSEL' }) });`,
    });
    expect(result.outOfCycle).toEqual([]);
  });

  it('lists a request that names a metric Meta replaced on every version, and nothing broader', async () => {
    const changes = await loadMetaGraphChanges(undefined, NOW);
    const change = changes.changes.find(
      (entry) =>
        entry.version === null && entry.kind.startsWith('metric-') && entry.replacement !== null,
    )!;
    const result = await plan({
      'insights.ts': `export const read = (id: string) => fetch(\`https://graph.facebook.com/v22.0/\${id}/insights?metric=${change.name}\`);`,
      'page.ts': `export const read = (id: string) => fetch(\`https://graph.facebook.com/v22.0/\${id}\`);`,
    });
    expect(result.outOfCycle).toEqual([
      expect.objectContaining({ file: 'insights.ts', change: change.id }),
    ]);
  });
});

describe('Meta Graph rule and alert files', () => {
  it('joins each committed rule to its change, and rejects a rule whose change is missing', async () => {
    const changes = await loadMetaGraphChanges(undefined, NOW);
    const rules = await loadMetaGraphRules(changes);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const change = changes.changes.find((entry) => entry.id === rule.change)!;
      expect(rule.version).toBe(change.version);
      expect(rule.status).toBe('review');
    }
    expect(await loadMetaGraphRules(changes, join(tmpdir(), 'refit-no-such-rules'))).toEqual([]);
    const root = await directory({
      'v22.0.json': JSON.stringify({
        formatVersion: 1,
        provider: 'meta-graph',
        version: 'v22.0',
        rules: [{ rule: 'x-replacement', family: 'field-replacement', change: 'no-such-change' }],
      }),
    });
    await expect(loadMetaGraphRules(changes, root)).rejects.toThrow('a change in the change table');
  });

  it('checks the committed alerts', async () => {
    const alerts = await loadMetaPlatformAlerts();
    expect(alerts.length).toBeGreaterThan(5);
    for (const alert of alerts)
      expect(alert.source).toMatch(/^https:\/\/developers\.facebook\.com\//);
  });
});
