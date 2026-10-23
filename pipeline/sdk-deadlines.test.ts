import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { detectProviders } from './agent-catalog.ts';
import { deadlineTitle } from './deadline-alerts.ts';
import { scanDeadlines } from './deadline-exposure.ts';
import { checkDeadlineRegistry, loadDeadlineRegistry } from './deadline-registry.ts';
import {
  featureMatches,
  installedVersion,
  rangesOverlap,
  markerInProse,
  satisfiesRange,
  sdkTarget,
  validRange,
} from './sdk-deadlines.ts';

const NOW = new Date('2026-10-22T12:00:00Z');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-sdk-deadlines-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(
      join(root, name),
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    );
  }
  return root;
}

// The shipped registry's exposures and mentions in a fixture, as `id file:line use` lines.
async function shipped(files: Record<string, unknown>) {
  const registry = await loadDeadlineRegistry(undefined, NOW);
  const scan = await scanDeadlines(await repository(files), registry, NOW);
  return {
    scan,
    lines: [...scan.exposures, ...scan.mentions]
      .flatMap((exposure) =>
        [...exposure.evidence, ...exposure.nonLive].map(
          (item) => `${exposure.deadline.id} ${item.file}:${item.line} ${item.use}`,
        ),
      )
      .sort(),
  };
}

function manifest(dependencies: Record<string, string>, lock?: Record<string, string>) {
  return {
    'package.json': { name: 'app', dependencies },
    ...(lock
      ? {
          'package-lock.json': {
            lockfileVersion: 3,
            packages: {
              '': { dependencies },
              ...Object.fromEntries(
                Object.entries(lock).map(([name, version]) => [
                  `node_modules/${name}`,
                  { version },
                ]),
              ),
            },
          },
        }
      : {}),
  };
}

it('reads package ranges without taking a scoped name apart', () => {
  expect(sdkTarget('@clerk/nextjs@>=5 <7')).toEqual({ name: '@clerk/nextjs', range: '>=5 <7' });
  expect(sdkTarget('auth0@>=6 <7')).toEqual({ name: 'auth0', range: '>=6 <7' });
  expect(sdkTarget('@supabase/auth-helpers-nextjs')).toEqual({
    name: '@supabase/auth-helpers-nextjs',
    range: null,
  });
  expect(sdkTarget('firebase')).toEqual({ name: 'firebase', range: null });
  for (const range of ['<5', '>=5 <7', '<=4.31.8', '=1.2.3', '>0.9'])
    expect(validRange(range)).toBe(true);
  for (const range of ['', '^5', '5 || 6', '<five', '>=5 <7 ||'])
    expect(validRange(range)).toBe(false);
});

it('places versions in ranges, with prereleases counting as their release', () => {
  expect(satisfiesRange('4.29.3', '<5')).toBe(true);
  expect(satisfiesRange('5.0.0', '<5')).toBe(false);
  expect(satisfiesRange('6.39.8', '>=5 <7')).toBe(true);
  expect(satisfiesRange('7.0.0', '>=5 <7')).toBe(false);
  expect(satisfiesRange('4.31.8', '<=4.31.8')).toBe(true);
  expect(satisfiesRange('5.0.0-beta.1', '>=5 <7')).toBe(true);
  expect(satisfiesRange('not-a-version', '<5')).toBe(false);
});

it('takes the locked version, or the lowest release of a bounded declared range', () => {
  expect(installedVersion('^4.2.0', '4.29.3')).toBe('4.29.3');
  expect(installedVersion('^4.2.0', null)).toBe('4.2.0');
  expect(installedVersion('~6.1', null)).toBe('6.1.0');
  expect(installedVersion('4.x', null)).toBe('4.0.0');
  expect(installedVersion('5', null)).toBe('5.0.0');
  expect(installedVersion('v6.4.0', null)).toBe('6.4.0');
  expect(installedVersion('^5.0.0-beta.3', null)).toBe('5.0.0');
  // Open ranges and non-registry specifiers could install any major.
  for (const declared of ['>=4', '*', 'latest', '^4 || ^5', 'workspace:*', 'github:clerk/js'])
    expect(installedVersion(declared, null)).toBeNull();
});

it('finds every marker on a line with its column', () => {
  expect(
    featureMatches("a('SUPABASE_ANON_KEY'), b.NEXT_PUBLIC_SUPABASE_ANON_KEY", [
      { provider: 'supabase', marker: 'SUPABASE_ANON_KEY' },
    ]),
  ).toEqual([
    { provider: 'supabase', marker: 'SUPABASE_ANON_KEY', column: 3 },
    { provider: 'supabase', marker: 'SUPABASE_ANON_KEY', column: 38 },
  ]);
});

it('rejects a registry package range Refit cannot read', () => {
  const entry = {
    id: 'clerk-bad-range',
    provider: 'clerk',
    kind: 'sdk',
    versions: ['@clerk/nextjs@^4 || ^5'],
    date: '2027-01-01',
    summary: 'A range with an operator Refit does not read.',
    replacement: null,
    source: 'https://example.com/clerk',
    checkedAt: '2026-10-22',
  };
  expect(checkDeadlineRegistry({ formatVersion: 1, deadlines: [entry] }, NOW).errors).toEqual([
    'clerk-bad-range: @clerk/nextjs@^4 || ^5 has a version range Refit cannot read.',
  ]);
  expect(
    checkDeadlineRegistry(
      { formatVersion: 1, deadlines: [{ ...entry, versions: ['@clerk/nextjs@<5'] }] },
      NOW,
    ).errors,
  ).toEqual([]);
});

it('reports a Clerk major by its support stage, from the lockfile or the declared range', async () => {
  const source = { 'src/app.tsx': "import { ClerkProvider } from '@clerk/nextjs';" };
  const core1 = await shipped({
    ...manifest({ '@clerk/nextjs': '^4.29.0' }, { '@clerk/nextjs': '4.31.8' }),
    ...source,
  });
  expect(core1.lines).toEqual(['clerk-2025-04-19-core-1-unsupported package.json:4 live']);
  expect(core1.scan.exposures[0].evidence[0].text).toBe(
    '@clerk/nextjs 4.31.8 (locked in package-lock.json) is declared in dependencies, inside <5',
  );
  expect(deadlineTitle(core1.scan.exposures[0])).toBe(
    'Clerk package @clerk/nextjs@<5 passed its sunset on 2025-04-19',
  );
  // Without a lockfile, a caret range fixes the major.
  const core2 = await shipped({ ...manifest({ '@clerk/nextjs': '^6.1.0' }), ...source });
  expect(core2.lines).toEqual(['clerk-2027-01-01-core-2-lts-ends package.json:4 live']);
  expect(core2.scan.exposures[0].days).toBe(71);
  // The current major, and a range that could install any major, match nothing.
  expect((await shipped({ ...manifest({ '@clerk/nextjs': '^7.0.0' }), ...source })).lines).toEqual(
    [],
  );
  expect((await shipped({ ...manifest({ '@clerk/nextjs': '*' }), ...source })).lines).toEqual([]);
});

it('matches each Clerk package range, the removed Node SDK and Elements', async () => {
  const packages = {
    '@clerk/clerk-react': '4.32.5',
    '@clerk/backend': '0.38.15',
    '@clerk/remix': '4.13.0',
    '@clerk/clerk-sdk-node': '5.1.6',
    '@clerk/elements': '0.24.13',
    '@clerk/express': '1.7.84',
    '@clerk/types': '4.101.20',
  };
  const { lines } = await shipped({
    ...manifest(packages),
    'src/clerk.ts': Object.keys(packages)
      .map((name, index) => `import * as clerk${index} from '${name}';`)
      .join('\n'),
  });
  expect(lines).toEqual([
    'clerk-2025-01-10-clerk-sdk-node package.json:7 live',
    'clerk-2025-04-19-core-1-unsupported package.json:4 live',
    'clerk-2025-04-19-core-1-unsupported package.json:5 live',
    'clerk-2026-03-03-elements package.json:8 live',
    'clerk-2027-01-01-core-2-lts-ends package.json:10 live',
    'clerk-2027-01-01-core-2-lts-ends package.json:6 live',
    'clerk-2027-01-01-core-2-lts-ends package.json:9 live',
  ]);
});

it('reports node-auth0 v6 only, and not v5 or v7', async () => {
  const source = { 'src/auth.ts': "import { ManagementClient } from 'auth0';" };
  expect(
    (await shipped({ ...manifest({ auth0: '^6.2.0' }, { auth0: '6.4.0' }), ...source })).lines,
  ).toEqual(['auth0-2026-09-09-node-auth0-v6 package.json:4 live']);
  for (const version of ['^5.14.0', '^7.0.0'])
    expect((await shipped({ ...manifest({ auth0: version }), ...source })).lines).toEqual([]);
});

it('reports every deprecated Supabase auth helper and not @supabase/ssr', async () => {
  const { lines, scan } = await shipped({
    ...manifest({
      '@supabase/auth-helpers-nextjs': '^0.10.0',
      '@supabase/auth-helpers-react': '^0.5.0',
      '@supabase/ssr': '^0.5.0',
      '@supabase/supabase-js': '^2.45.0',
    }),
    'examples/remix/package.json': {
      name: 'demo',
      dependencies: { '@supabase/auth-helpers-remix': '0.4.0' },
    },
    'src/supabase.ts': [
      "import { createPagesBrowserClient } from '@supabase/auth-helpers-nextjs';",
      "import { useSession } from '@supabase/auth-helpers-react';",
      "import { createRemixServerClient } from '@supabase/auth-helpers-remix';",
      "import { createServerClient } from '@supabase/ssr';",
    ].join('\n'),
  });
  expect(lines).toEqual([
    'supabase-2024-11-27-auth-helpers examples/remix/package.json:4 test',
    'supabase-2024-11-27-auth-helpers package.json:4 live',
    'supabase-2024-11-27-auth-helpers package.json:5 live',
  ]);
  expect(deadlineTitle(scan.exposures[0])).toBe(
    'Supabase packages @supabase/auth-helpers-nextjs, @supabase/auth-helpers-react passed its sunset on 2024-11-27',
  );
});

it('reports Supabase legacy key variables in code, apart from comments and tests', async () => {
  const { lines, scan } = await shipped({
    ...manifest({ '@supabase/supabase-js': '^2.45.0' }),
    'src/client.ts': [
      "import { createClient } from '@supabase/supabase-js';",
      '// Reads SUPABASE_ANON_KEY from the environment.',
      'export const supabase = createClient(',
      '  process.env.NEXT_PUBLIC_SUPABASE_URL!,',
      '  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,',
      ');',
      "export const admin = createClient(url, process.env['SUPABASE_SERVICE_ROLE_KEY']!);",
      'export const vite = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;',
    ].join('\n'),
    'tests/client.test.ts': 'process.env.SUPABASE_ANON_KEY = "test";',
  });
  expect(lines).toEqual([
    'supabase-2026-12-31-legacy-api-keys src/client.ts:2 comment',
    'supabase-2026-12-31-legacy-api-keys src/client.ts:5 live',
    'supabase-2026-12-31-legacy-api-keys src/client.ts:7 live',
    'supabase-2026-12-31-legacy-api-keys tests/client.test.ts:1 test',
  ]);
  expect(deadlineTitle(scan.exposures[0])).toBe(
    'Supabase use of SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY reaches its sunset on 2026-12-31',
  );
});

it('reports Firebase Dynamic Links by option, REST host and React Native module', async () => {
  const { lines } = await shipped({
    ...manifest({ firebase: '^10.0.0' }),
    'src/email.ts': [
      "import { sendSignInLinkToEmail } from 'firebase/auth';",
      'await sendSignInLinkToEmail(auth, email, {',
      "  url: 'https://example.com/finish',",
      "  dynamicLinkDomain: 'example.page.link',",
      '});',
    ].join('\n'),
    'src/share.ts': [
      'const response = await fetch(',
      '  `https://firebasedynamiclinks.googleapis.com/v1/shortLinks?key=${key}`,',
      ');',
    ].join('\n'),
    'src/native.ts': "import dynamicLinks from '@react-native-firebase/dynamic-links';",
    // The replacement option is not a Dynamic Links use.
    'src/new.ts': "const settings = { url, linkDomain: 'example.web.app' };",
  });
  expect(lines).toEqual([
    'firebase-2025-08-01-dynamic-links src/email.ts:4 live',
    'firebase-2025-08-01-dynamic-links src/native.ts:1 live',
    'firebase-2025-08-01-dynamic-links src/share.ts:2 live',
  ]);
});

it('detects Auth0, Clerk, Firebase and Supabase by package and API host', async () => {
  const root = await repository({
    'package.json': {
      name: 'app',
      dependencies: {
        '@auth0/nextjs-auth0': '^4.0.0',
        '@clerk/nextjs': '^7.0.0',
        'firebase-admin': '^13.0.0',
        '@supabase/ssr': '^0.5.0',
      },
    },
    'src/hosts.ts': [
      "const issuer = 'https://my-tenant.us.auth0.com/';",
      "const clerk = 'https://api.clerk.com/v1/users';",
      "const db = 'https://my-app-default-rtdb.firebaseio.com';",
      "const project = 'https://abcdefgh.supabase.co';",
    ].join('\n'),
  });
  const detections = Object.fromEntries(
    (await detectProviders(root)).map((item) => [
      item.agent.id,
      {
        packages: item.packages.map((entry) => entry.name),
        hostnames: item.hostnames.map((entry) => `${entry.line} ${entry.hostname}`),
      },
    ]),
  );
  expect(detections).toEqual({
    auth0: { packages: ['@auth0/nextjs-auth0'], hostnames: ['1 .auth0.com'] },
    clerk: { packages: ['@clerk/nextjs'], hostnames: ['2 api.clerk.com'] },
    firebase: { packages: ['firebase-admin'], hostnames: ['3 firebaseio.com'] },
    supabase: { packages: ['@supabase/ssr'], hostnames: ['4 .supabase.co'] },
  });
});

// Line shapes from the frozen sample (docs/AUTH-BACKEND-SDKS.md): a key variable named in an error
// message or a generated `.env` template is not a read; a name-only string is.
it('lists a legacy key variable named inside prose as a comment, and keeps name-only strings live', async () => {
  const { lines } = await shipped({
    ...manifest({ '@supabase/supabase-js': '^2.45.0' }),
    'lib/admin.ts': [
      "import { createClient } from '@supabase/supabase-js';",
      "if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY environment variable');",
      "const required = ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];",
      "const anon = Deno.env.get('SUPABASE_ANON_KEY');",
      'const env = `NEXT_PUBLIC_SUPABASE_ANON_KEY=${answers.anonKey}`;',
      'const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;',
    ].join('\n'),
  });
  expect(lines).toEqual([
    'supabase-2026-12-31-legacy-api-keys lib/admin.ts:2 comment',
    // One item for each of the two names on the line.
    'supabase-2026-12-31-legacy-api-keys lib/admin.ts:3 live',
    'supabase-2026-12-31-legacy-api-keys lib/admin.ts:3 live',
    'supabase-2026-12-31-legacy-api-keys lib/admin.ts:4 live',
    'supabase-2026-12-31-legacy-api-keys lib/admin.ts:5 comment',
    'supabase-2026-12-31-legacy-api-keys lib/admin.ts:6 live',
  ]);
  expect(markerInProse('SUPABASE_ANON_KEY', 'Set SUPABASE_ANON_KEY first')).toBe(true);
  expect(markerInProse('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY')).toBe(false);
  expect(markerInProse('SUPABASE_ANON_KEY', undefined)).toBe(false);
  // Hostnames and module names live inside longer strings.
  expect(
    markerInProse(
      'firebasedynamiclinks.googleapis.com',
      'https://firebasedynamiclinks.googleapis.com/v1/shortLinks',
    ),
  ).toBe(false);
});

it('reports next-auth v3 and older, and not v4 or the v5 beta', async () => {
  const source = { 'pages/api/auth/[...nextauth].ts': "import NextAuth from 'next-auth';" };
  expect(
    (
      await shipped({
        ...manifest({ 'next-auth': '^3.29.0' }, { 'next-auth': '3.29.10' }),
        ...source,
      })
    ).lines,
  ).toEqual(['nextauth-2022-08-01-next-auth-v3 package.json:4 live']);
  for (const version of ['^4.24.11', '5.0.0-beta.25'])
    expect((await shipped({ ...manifest({ 'next-auth': version }), ...source })).lines).toEqual([]);
  const detected = await detectProviders(
    await repository({ ...manifest({ 'next-auth': '^4.24.11' }), ...source }),
  );
  expect(detected.map((item) => [item.agent.id, item.hostnames.length])).toEqual([['nextauth', 0]]);
});

it('rejects package ranges that give one release two deadlines', () => {
  expect(rangesOverlap('<5', '>=5 <7')).toBe(false);
  expect(rangesOverlap('<=5', '>=5')).toBe(true);
  expect(rangesOverlap('>=5 <7', '>=6')).toBe(true);
  expect(rangesOverlap(null, '<5')).toBe(true);
  expect(rangesOverlap('=4.2.0', '<4.2.0')).toBe(false);
  const entry = (id: string, versions: string[]) => ({
    id,
    provider: 'clerk',
    kind: 'sdk',
    versions,
    date: '2027-01-01',
    summary: `${id} ends.`,
    replacement: null,
    source: 'https://example.com/clerk',
    checkedAt: '2026-10-22',
  });
  expect(
    checkDeadlineRegistry(
      {
        formatVersion: 1,
        deadlines: [
          entry('clerk-core-1', ['@clerk/nextjs@<5']),
          entry('clerk-core-2', ['@clerk/nextjs@>=5 <7']),
          entry('clerk-wide', ['@clerk/nextjs@>=6']),
          entry('clerk-all', ['@clerk/nextjs']),
        ],
      },
      NOW,
    ).errors,
  ).toEqual([
    'clerk-wide: @clerk/nextjs@>=6 overlaps @clerk/nextjs@>=5 <7 in clerk-core-2, so a release would have two deadlines.',
    'clerk-all: @clerk/nextjs overlaps @clerk/nextjs@<5 in clerk-core-1, so a release would have two deadlines.',
    'clerk-all: @clerk/nextjs overlaps @clerk/nextjs@>=5 <7 in clerk-core-2, so a release would have two deadlines.',
    'clerk-all: @clerk/nextjs overlaps @clerk/nextjs@>=6 in clerk-wide, so a release would have two deadlines.',
  ]);
});

it('matches a hostname only where it ends, not inside a longer name', async () => {
  const root = await repository({
    'src/hosts.ts': [
      "const dashboard = 'https://app.supabase.com/project/abc';",
      "const api = 'https://api.supabase.com/v1/projects';",
    ].join('\n'),
  });
  expect(await detectProviders(root)).toEqual([]);
});
