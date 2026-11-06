import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SurfaceCollector } from './collector.ts';
import { DEMO_NEXT_WEB, DEMO_NODE_API, DEMO_PYTHON_APP, lineOf } from './fixtures.ts';
import { findSurfaceLeads, formatLeads } from './scanners.ts';
import type { SurfaceLead } from './scanners.ts';
import { makeRepo, removeRepo } from './test-fixtures.ts';

const dirs: Record<string, string> = {};
beforeAll(async () => {
  for (const fixture of [DEMO_NODE_API, DEMO_PYTHON_APP, DEMO_NEXT_WEB]) {
    dirs[fixture.repo] = await makeRepo(fixture.files);
  }
});
afterAll(async () => {
  for (const dir of Object.values(dirs)) await removeRepo(dir);
});

const at = (leads: SurfaceLead[], file: string, line?: number) =>
  leads.filter((lead) => lead.file === file && (line === undefined || lead.line === line));

describe('findSurfaceLeads', () => {
  it("points at demo-node-api's Kubernetes manifests and serverless runtime", async () => {
    const { leads } = await findSurfaceLeads(dirs[DEMO_NODE_API.repo]);
    expect(
      at(leads, 'k8s/ingress.yaml', lineOf(DEMO_NODE_API, 'k8s/ingress.yaml', 'apiVersion')),
    ).toContainEqual(
      expect.objectContaining({ area: 'infrastructure', text: 'apiVersion: extensions/v1beta1' }),
    );
    expect(at(leads, 'k8s/ingress.yaml')).toContainEqual(
      expect.objectContaining({ signal: 'Kubernetes kind', text: 'kind: Ingress' }),
    );
    expect(at(leads, 'k8s/deployment.yaml')).toContainEqual(
      expect.objectContaining({ signal: 'Kubernetes kind', text: 'kind: Deployment' }),
    );
    expect(at(leads, 'serverless.yml')).toContainEqual(
      expect.objectContaining({ signal: 'Serverless Framework' }),
    );
    expect(
      at(leads, 'serverless.yml', lineOf(DEMO_NODE_API, 'serverless.yml', 'runtime:')),
    ).toContainEqual(expect.objectContaining({ signal: 'Serverless runtime' }));
    expect(at(leads, 'src/server.js')).toContainEqual(
      expect.objectContaining({ area: 'regulated', signal: 'AI feature' }),
    );
  });

  it("points at demo-next-web's checkout, cookie banner and signup form", async () => {
    const { leads } = await findSurfaceLeads(dirs[DEMO_NEXT_WEB.repo], { area: 'regulated' });
    expect(leads.every((lead) => lead.area === 'regulated')).toBe(true);
    expect(at(leads, 'pages/checkout.tsx')).toContainEqual(
      expect.objectContaining({ signal: 'Payments or checkout' }),
    );
    expect(at(leads, 'components/CookieBanner.tsx')).toContainEqual(
      expect.objectContaining({ signal: 'Cookies, consent or tracking' }),
    );
    expect(
      at(leads, 'pages/signup.tsx', lineOf(DEMO_NEXT_WEB, 'pages/signup.tsx', '<img')),
    ).toContainEqual(expect.objectContaining({ signal: 'Forms and interactive UI' }));
    expect(at(leads, 'pages/signup.tsx')).toContainEqual(
      expect.objectContaining({ signal: 'Personal data' }),
    );
  });

  it("points at demo-next-web's browser targets and demo-python-app's checkout", async () => {
    const next = await findSurfaceLeads(dirs[DEMO_NEXT_WEB.repo], { area: 'platforms' });
    expect(at(next.leads, 'package.json')).toContainEqual(
      expect.objectContaining({ signal: 'browserslist' }),
    );
    const python = await findSurfaceLeads(dirs[DEMO_PYTHON_APP.repo]);
    expect(at(python.leads, 'app.py')).toContainEqual(
      expect.objectContaining({ signal: 'Payments or checkout' }),
    );
    expect(at(python.leads, 'templates/checkout.html')).toContainEqual(
      expect.objectContaining({ signal: 'Forms and interactive UI' }),
    );
  });

  it('formats leads by area and says they are pointers', async () => {
    const text = formatLeads(await findSurfaceLeads(dirs[DEMO_NODE_API.repo]));
    expect(text).toMatch(/^infrastructure:|\ninfrastructure:/);
    expect(text).toContain('k8s/ingress.yaml:1: apiVersion: extensions/v1beta1');
    expect(text).toContain('Read the files before recording');
    expect(formatLeads({ leads: [], truncated: [] })).toContain('Read the repository directly');
  });
});

describe('SurfaceCollector', () => {
  it('keeps verified lines, rejects wrong ones, and merges repeat reports', async () => {
    const collector = new SurfaceCollector(dirs[DEMO_NODE_API.repo], DEMO_NODE_API.repo);
    const line = lineOf(DEMO_NODE_API, 'serverless.yml', 'runtime:');
    const first = await collector.record({
      kind: 'infrastructure',
      name: 'aws-lambda',
      ecosystem: 'aws',
      version: 'nodejs16.x',
      locations: [
        { file: 'serverless.yml', line },
        { file: 'serverless.yml', line: 999 },
        { file: '../outside.yml', line: 1 },
      ],
      notes: 'Lambda runtime nodejs16.x is deprecated by AWS.',
    });
    expect(first.saved).toBe(true);
    expect(first.accepted).toEqual([{ file: 'serverless.yml', line, text: 'runtime: nodejs16.x' }]);
    expect(first.rejected.map((item) => item.line)).toEqual([999, 1]);
    expect(first.rejected[1].reason).toContain('outside the repository');

    await collector.record({
      kind: 'infrastructure',
      name: 'AWS-Lambda ',
      ecosystem: 'aws',
      locations: [
        { file: 'serverless.yml', line: lineOf(DEMO_NODE_API, 'serverless.yml', 'handler') },
      ],
      notes: 'Function nightly runs src/jobs.js.',
    });
    const [only] = collector.surfacesForOutput();
    expect(collector.list()).toHaveLength(1);
    expect(only.declaredIn).toHaveLength(2);
    expect(only.notes).toContain('deprecated');
    expect(only.notes).toContain('nightly');
    expect(only.version).toBe('nodejs16.x');

    const nothing = await collector.record({
      kind: 'platform',
      name: 'android-app',
      locations: [{ file: 'missing.gradle', line: 1 }],
      notes: 'guess',
    });
    expect(nothing.saved).toBe(false);
    expect(collector.list()).toHaveLength(1);

    expect(collector.remove(first.key, [{ file: 'serverless.yml', line }])).toBe(true);
    expect(collector.surfacesForOutput()[0].declaredIn).toHaveLength(1);
    expect(collector.remove(first.key)).toBe(true);
    expect(collector.list()).toHaveLength(0);
  });
});
