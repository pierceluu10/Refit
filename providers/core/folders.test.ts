import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Fetcher } from './fetch.ts';
import { snapshotFetcher } from './fetch.ts';
import { BudgetLedger } from './model.ts';
import {
  registriesFor,
  savedRegistry,
  type PackageInfo,
  type PackageRegistry,
} from './packages.ts';
import { fixtureDir } from './testing.ts';
import { folderHints, folderWatcher, loadProvider, mergeHints, watchAll } from './registry.ts';
import { scriptedModel } from './testing.ts';

// Illustrative provider "Acme": made-up pages and packages, not a real API.
const CHANGELOG = 'https://docs.acme.test/changelog';
const pages: Record<string, string> = {
  [CHANGELOG]: 'The legacy /v1/charges endpoint will be removed on 2027-01-31.',
};
const fetcher: Fetcher = {
  async fetch(url) {
    const text = pages[url];
    return {
      url,
      status: text ? 200 : 404,
      ok: Boolean(text),
      fetchedAt: '2026-11-03T00:00:00.000Z',
      contentType: 'text/plain',
      text: text ?? '',
    };
  },
};

const ACME_NODE: PackageInfo = {
  ecosystem: 'npm',
  name: 'acme-node',
  registryUrl: 'https://registry.npmjs.org/acme-node',
  pageUrl: 'https://www.npmjs.com/package/acme-node',
  readAt: '2026-11-03',
  description: 'Official Acme client',
  majors: [
    { major: 2, first: '2.0.0', latest: '2.1.0', releases: 2 },
    { major: 1, first: '1.0.0', latest: '1.0.0', releases: 1 },
  ],
  versions: 3,
};

/** Records each name it is asked for and answers from saved lookups. */
function recordingRegistry(saved: PackageInfo[] = []): PackageRegistry & { asked: string[] } {
  const inner = savedRegistry(saved);
  const asked: string[] = [];
  return {
    asked,
    lookup(name) {
      asked.push(name);
      return inner.lookup(name);
    },
  };
}

describe('provider folders and discovery', () => {
  it('watches a folder that has only provider.json with hints and a prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'apt-hints-only-'));
    try {
      mkdirSync(join(root, 'acme'));
      writeFileSync(
        join(root, 'acme', 'provider.json'),
        JSON.stringify({
          id: 'acme',
          name: 'Acme Payments',
          hints: { packages: ['acme-node'], docsUrls: [CHANGELOG] },
        }),
      );
      writeFileSync(
        join(root, 'acme', 'prompt.md'),
        'Acme pins versions with an Acme-Version header.',
      );
      expect(loadProvider('acme', root).sources).toEqual([]);

      const model = scriptedModel([
        [{ type: 'tool_use', id: 'r', name: 'read_page', input: { source_id: 'docs-1' } }],
        [
          {
            type: 'tool_use',
            id: 's',
            name: 'submit_changes',
            input: {
              changes: [
                {
                  id: 'remove-v1-charges',
                  kind: 'endpoint-removed',
                  title: 'Acme removes /v1/charges on 2027-01-31',
                  source: {
                    url: CHANGELOG,
                    quote: 'The legacy /v1/charges endpoint will be removed on 2027-01-31.',
                  },
                  affects: { operations: ['/v1/charges'] },
                },
              ],
            },
          },
        ],
      ]);
      const registry = recordingRegistry([ACME_NODE]);
      const changes = await folderWatcher('acme', {
        root,
        model,
        fetcher,
        registry,
        budget: new BudgetLedger(100),
      })();
      expect(changes.map((change) => change.id)).toEqual(['acme:remove-v1-charges']);
      expect(registry.asked).toEqual(['acme-node']);
      expect(model.requests[0].system).toContain('Acme pins versions with an Acme-Version header.');
      const prompt = JSON.stringify(model.requests[0].messages[0]);
      expect(prompt).toContain(`docs-1 [other] ${CHANGELOG}`);
      expect(prompt).toContain('### npm package acme-node');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts a classic folder's read from its pages, prompt and knowledge, and looks up its SDKs where they live", async () => {
    const twilio = loadProvider('twilio');
    expect(folderHints(twilio).packages).toEqual(
      expect.arrayContaining(['npm:twilio', 'pypi:twilio', 'github.com/twilio/twilio-go']),
    );
    const model = scriptedModel([
      [
        {
          type: 'tool_use',
          id: 'r',
          name: 'read_page',
          input: { source_id: twilio.sources[0].id },
        },
      ],
      [{ type: 'tool_use', id: 's', name: 'submit_changes', input: { changes: [] } }],
    ]);
    const registry = recordingRegistry();
    await folderWatcher('twilio', {
      model,
      fetcher: snapshotFetcher(fixtureDir(twilio)),
      registry,
      budget: new BudgetLedger(100),
    })();
    // npm and PyPI names keep their registry; the Go module leads to its repository instead.
    expect(registry.asked).toEqual(expect.arrayContaining(['npm:twilio', 'pypi:twilio']));
    expect(model.requests[0].system).toContain(twilio.prompt.trim().slice(0, 60));
    const prompt = JSON.stringify(model.requests[0].messages[0]);
    for (const source of twilio.sources) expect(prompt).toContain(`${source.id} [${source.kind}]`);
    expect(prompt).toContain('https://api.github.com/repos/twilio/twilio-go/releases?per_page=100');
    expect(prompt).toContain('What Aptitude already knows (knowledge.json, may be stale)');
  });

  it('reads every folder in one run with one shared budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'apt-watch-all-'));
    try {
      for (const id of ['acme', 'bolt']) {
        mkdirSync(join(root, id));
        writeFileSync(
          join(root, id, 'provider.json'),
          JSON.stringify({ id, name: id, hints: { docsUrls: [CHANGELOG] } }),
        );
        writeFileSync(join(root, id, 'prompt.md'), `${id} announces changes in its changelog.`);
      }
      const budget = new BudgetLedger(100);
      const reports = await watchAll(undefined, {
        root,
        model: scriptedModel([
          [{ type: 'tool_use', id: 's', name: 'submit_changes', input: { changes: [] } }],
        ]),
        fetcher,
        registry: recordingRegistry(),
        budget,
      });
      expect(reports.map((report) => report.provider)).toEqual(['acme', 'bolt']);
      expect(budget.entries).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('merges hints and pins folder SDKs to their registry', () => {
    expect(
      mergeHints(
        { packages: ['npm:octokit', 'octokit'], hosts: ['api.github.com'] },
        { packages: ['octokit'], docsUrls: ['https://docs.github.com/rest'] },
        {},
      ),
    ).toEqual({
      packages: ['npm:octokit', 'octokit'],
      hosts: ['api.github.com'],
      docsUrls: ['https://docs.github.com/rest'],
    });
    expect(registriesFor('npm:octokit')).toEqual(['npm']);
    expect(registriesFor('pypi:openai')).toEqual(['pypi']);
  });

  it('answers a pinned lookup only from that registry', async () => {
    const both: PackageInfo[] = [ACME_NODE, { ...ACME_NODE, ecosystem: 'pypi' }];
    expect(
      (await savedRegistry(both).lookup('npm:acme-node')).found.map((i) => i.ecosystem),
    ).toEqual(['npm']);
    expect((await savedRegistry(both).lookup('acme-node')).found).toHaveLength(2);
  });

  it('fails the read of a folder that does not load, rather than watching it without its pages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'apt-broken-folder-'));
    try {
      mkdirSync(join(root, 'acme'));
      writeFileSync(join(root, 'acme', 'provider.json'), '{ "id": "acme", "name": "Acme", }');
      writeFileSync(join(root, 'acme', 'prompt.md'), 'Acme announces changes in its changelog.');
      const model = scriptedModel([[{ type: 'text', text: 'never asked' }]]);
      await expect(
        folderWatcher('acme', {
          root,
          model,
          fetcher,
          registry: recordingRegistry(),
          budget: new BudgetLedger(100),
        })(),
      ).rejects.toBeInstanceOf(SyntaxError);
      expect(model.requests).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
