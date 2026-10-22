import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProviders } from './agent-catalog.ts';
import { scanDeadlines } from './deadline-exposure.ts';
import { checkDeadlineRegistry, loadDeadlineRegistry } from './deadline-registry.ts';
import {
  manifestKind,
  matchesPackage,
  normalizePythonName,
  readPackageManifests,
  type ManifestDependency,
} from './package-manifests.ts';
import { parseToml, TomlError } from './package-manifests-toml.ts';

// Real manifests copied from public repositories; each file's header names its source commit.
const FIXTURES = join(import.meta.dirname, 'fixtures', 'package-manifests');

async function parseFixture(path: string) {
  const content = (await readFile(join(FIXTURES, path), 'utf8')).replace(/^\uFEFF/, '');
  return manifestKind(basename(path))!.parse(content, path);
}

function pick(dependencies: Omit<ManifestDependency, 'locked'>[], name: string) {
  return dependencies.find((dependency) => dependency.name === name);
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-manifests-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe('TOML reader', () => {
  it('reads tables, arrays of tables, dotted keys, strings, arrays and inline tables', () => {
    const document = parseToml(
      [
        '# comment',
        'title = "a \\"quoted\\" \\u00e9"',
        "literal = 'C:\\path'",
        'multi = """',
        'one \\',
        '   two"""',
        "raw = '''x'y'''",
        'numbers = [1, 2_000, -3.5, 0x1f, 1e3, inf]',
        'when = 2026-10-22T08:00:00Z',
        'day = 2026-10-22',
        '[project]',
        'dependencies = [',
        '  "stripe>=15", # trailing comment',
        "  'openai',",
        ']',
        'site."docs.example".url = "https://example.com"',
        '[project.optional-dependencies]',
        'dev = ["pytest"]',
        '[[package]]',
        'name = "a"',
        'source = { registry = "https://pypi.org/simple", nested = { ok = true } }',
        '[[package]]',
        'name = "b"',
        '[package.dependencies]',
        'c = "*"',
      ].join('\n'),
    );
    expect(document).toEqual({
      title: 'a "quoted" é',
      literal: 'C:\\path',
      multi: 'one two',
      raw: "x'y",
      numbers: [1, 2000, -3.5, 31, 1000, Infinity],
      when: '2026-10-22T08:00:00Z',
      day: '2026-10-22',
      project: {
        dependencies: ['stripe>=15', 'openai'],
        site: { 'docs.example': { url: 'https://example.com' } },
        'optional-dependencies': { dev: ['pytest'] },
      },
      package: [
        { name: 'a', source: { registry: 'https://pypi.org/simple', nested: { ok: true } } },
        { name: 'b', dependencies: { c: '*' } },
      ],
    });
  });

  it.each([
    ['unterminated string', 'a = "open', 1],
    ['duplicate key', 'a = 1\na = 2', 2],
    ['table defined twice', '[a]\n[a]', 2],
    ['missing value', 'a =\n', 1],
    ['garbage after value', 'a = 1 2', 1],
    ['unclosed array', 'a = [1, 2', 1],
    ['bad escape', 'a = "\\q"', 1],
  ])('rejects a %s with its line', (_name, text, line) => {
    expect(() => parseToml(text)).toThrow(TomlError);
    try {
      parseToml(text);
    } catch (error) {
      expect((error as TomlError).line).toBe(line);
    }
  });
});

describe('Python manifests', () => {
  it('reads pinned requirements and records -r includes and -c constraints as non-packages', async () => {
    const all = await parseFixture('python/home-assistant/requirements_all.txt');
    expect(all.includes).toEqual([{ file: 'python/home-assistant/requirements.txt', line: 5 }]);
    expect(all.dependencies).toHaveLength(1179);
    expect(all.stops).toEqual([]);
    expect(
      ['anthropic', 'openai', 'google-genai', 'twilio', 'sendgrid'].map((name) => {
        const dependency = pick(all.dependencies, name)!;
        return [name, dependency.declared, dependency.line];
      }),
    ).toEqual([
      ['anthropic', '==1.15.0', 572],
      ['openai', '==3.26.0', 1882],
      ['google-genai', '==2.25.0', 1200],
      ['twilio', '==6.32.0', 3387],
      ['sendgrid', '==6.8.2', 3098],
    ]);
    const test = await parseFixture('python/home-assistant/requirements_test.txt');
    expect(test.includes.map((include) => include.file)).toEqual([
      'python/home-assistant/requirements_test_pre_commit.txt',
    ]);
    // Names are PEP 503-normalised: aiohttp_cors is aiohttp-cors on PyPI.
    const core = await parseFixture('python/home-assistant/requirements.txt');
    expect(pick(core.dependencies, 'aiohttp-cors')?.declared).toBe('==0.8.1');
  });

  it('follows -r includes across the repository and reports each file once', async () => {
    const inventory = await readPackageManifests(join(FIXTURES, 'python', 'home-assistant'));
    expect(inventory.manifests.map((entry) => entry.file)).toEqual([
      'requirements_all.txt',
      'requirements_test_pre_commit.txt',
      'requirements_test.txt',
      'requirements.txt',
    ]);
    expect(inventory.dependencies.filter((entry) => entry.name === 'openai')).toEqual([
      {
        ecosystem: 'pypi',
        name: 'openai',
        declared: '==3.26.0',
        locked: null,
        file: 'requirements_all.txt',
        line: 1882,
        direct: true,
      },
    ]);
  });

  it('reads PEP 621 dependencies, optional dependencies and dependency groups', async () => {
    const djStripe = await parseFixture('python/dj-stripe/pyproject.toml');
    expect(pick(djStripe.dependencies, 'stripe')).toMatchObject({
      declared: '>=15.0.1,<16',
      line: 27,
    });
    expect(pick(djStripe.dependencies, 'psycopg')?.declared).toBe('>=3.3.4,<4');
    const zulip = await parseFixture('python/zulip/pyproject.toml');
    expect(pick(zulip.dependencies, 'stripe')).toMatchObject({ declared: null, line: 123 });
    expect(pick(zulip.dependencies, 'openai')).toMatchObject({ declared: null, line: 190 });
  });

  it('reads Poetry dependencies and groups, skipping python, with poetry.lock versions', async () => {
    const parsed = await parseFixture('python/autogpt/pyproject.toml');
    expect(parsed.dependencies.some((entry) => entry.name === 'python')).toBe(false);
    expect(
      ['anthropic', 'openai', 'stripe', 'sentry-sdk'].map(
        (name) => pick(parsed.dependencies, name)?.declared,
      ),
    ).toEqual(['^0.79.0', '^1.97.1', '^11.5.0', '^2.44.0']);
    const inventory = await readPackageManifests(join(FIXTURES, 'python', 'autogpt'));
    expect(
      inventory.dependencies
        .filter((entry) => ['anthropic', 'openai', 'stripe'].includes(entry.name))
        .map((entry) => [entry.name, entry.locked, entry.line]),
    ).toEqual([
      ['anthropic', '0.79.0', 17],
      ['openai', '1.109.1', 50],
      ['stripe', '11.6.0', 79],
    ]);
  });

  it('gives PEP 621 dependencies their uv.lock versions', async () => {
    const inventory = await readPackageManifests(join(FIXTURES, 'python', 'zulip'));
    expect(
      inventory.dependencies
        .filter((entry) => ['stripe', 'openai', 'django'].includes(entry.name))
        .map((entry) => [entry.name, entry.declared, entry.locked]),
    ).toEqual([
      ['django', '==5.2.*', '5.2.18'],
      ['stripe', null, '16.0.0'],
      ['openai', null, '3.35.1'],
    ]);
  });

  it('reads Pipfile packages and Pipfile.lock versions', async () => {
    const pipfile = await parseFixture('python/pipenv/Pipfile');
    expect(pipfile.dependencies.map((entry) => [entry.name, entry.declared]).slice(0, 3)).toEqual([
      ['pytz', '*'],
      ['urllib3', '>=2.8.0'],
      ['requests', '>=2.34.2'],
    ]);
    // The lock excerpt also has attrs, which the Pipfile does not declare: it is not reported.
    const inventory = await readPackageManifests(join(FIXTURES, 'python', 'pipenv'));
    expect(
      inventory.dependencies
        .filter((entry) => entry.locked)
        .map((entry) => [entry.name, entry.locked]),
    ).toEqual([
      ['pytz', '2026.1.post1'],
      ['urllib3', '2.8.0'],
      ['requests', '2.34.2'],
      ['sphinx', '9.1.0'],
    ]);
  });

  it('reads editable and URL requirements that name their package and skips options', async () => {
    const root = await repository({
      'requirements.txt': [
        '--index-url https://pypi.org/simple',
        '-e git+https://github.com/stripe/stripe-python.git@v12.0.0#egg=stripe',
        'https://example.com/openai-1.0.tar.gz#egg=openai',
        './local-package',
        'anthropic[vertex] >= 0.40 ; python_version >= "3.9" \\',
        '    --hash=sha256:abc',
        'twilio (>=9)',
        'not a requirement !!',
      ].join('\n'),
    });
    const inventory = await readPackageManifests(root);
    expect(inventory.dependencies.map((entry) => [entry.name, entry.declared, entry.line])).toEqual(
      [
        ['stripe', 'git+https://github.com/stripe/stripe-python.git@v12.0.0#egg=stripe', 2],
        ['openai', 'https://example.com/openai-1.0.tar.gz', 3],
        ['anthropic', '>= 0.40', 5],
        ['twilio', '>=9', 7],
      ],
    );
    expect(inventory.stops).toEqual([
      {
        file: 'requirements.txt',
        line: 8,
        reason: 'unparseable-manifest',
        detail: 'Not a requirement: not a requirement !!',
      },
    ]);
  });

  it('normalises Python names as PEP 503 does', () => {
    expect(normalizePythonName('Google_GenAI')).toBe('google-genai');
    expect(normalizePythonName('ShopifyAPI')).toBe('shopifyapi');
    expect(normalizePythonName('zope.interface')).toBe('zope-interface');
  });
});

describe('Go modules', () => {
  it('reads require lines and blocks, marks indirect modules and locks them from go.sum', async () => {
    const inventory = await readPackageManifests(join(FIXTURES, 'go', 'stripe-samples'));
    expect(inventory.dependencies).toEqual([
      {
        ecosystem: 'go',
        name: 'github.com/joho/godotenv',
        declared: 'v1.5.1',
        locked: 'v1.5.1',
        file: 'go.mod',
        line: 7,
        direct: true,
      },
      {
        ecosystem: 'go',
        name: 'github.com/stripe/stripe-go/v84',
        declared: 'v84.3.0',
        locked: 'v84.3.0',
        file: 'go.mod',
        line: 8,
        direct: true,
      },
      {
        ecosystem: 'go',
        name: 'github.com/davecgh/go-spew',
        declared: 'v1.1.1',
        // go.sum also lists v1.1.0 (visited in the module graph); go.mod selects v1.1.1.
        locked: 'v1.1.1',
        file: 'go.mod',
        line: 11,
        direct: false,
      },
    ]);
  });

  it('reads a large go.mod with several require blocks and a toolchain line', async () => {
    const parsed = await parseFixture('go/stripe-cli/go.mod');
    expect(parsed.stops).toEqual([]);
    expect(parsed.dependencies).toHaveLength(92);
    expect(parsed.dependencies.filter((entry) => !entry.direct)).toHaveLength(49);
  });

  it('matches a catalog module at any major version suffix only', () => {
    const dependency = (name: string): ManifestDependency => ({
      ecosystem: 'go',
      name,
      declared: 'v1.0.0',
      locked: null,
      file: 'go.mod',
      line: 1,
      direct: true,
    });
    expect(
      matchesPackage(dependency('github.com/stripe/stripe-go/v84'), 'github.com/stripe/stripe-go'),
    ).toBe(true);
    expect(
      matchesPackage(dependency('github.com/stripe/stripe-go'), 'github.com/stripe/stripe-go'),
    ).toBe(true);
    expect(
      matchesPackage(
        dependency('github.com/stripe/stripe-go-extra'),
        'github.com/stripe/stripe-go',
      ),
    ).toBe(false);
    expect(
      matchesPackage(
        dependency('github.com/stripe/stripe-go/v84/client'),
        'github.com/stripe/stripe-go',
      ),
    ).toBe(false);
  });
});

describe('Ruby, PHP, Java, .NET and Rust manifests', () => {
  it('reads Gemfile requirements and Gemfile.lock versions', async () => {
    const inventory = await readPackageManifests(join(FIXTURES, 'ruby', 'forem'));
    const stripe = inventory.dependencies.find((entry) => entry.name === 'stripe');
    expect(stripe).toMatchObject({ declared: '~> 5.55', locked: '5.55.0', line: 120 });
    expect(inventory.dependencies).toHaveLength(171);
    expect(inventory.dependencies.every((entry) => entry.locked)).toBe(true);
    const samples = await parseFixture('ruby/stripe-samples/Gemfile');
    expect(samples.dependencies.map((entry) => [entry.name, entry.declared])).toContainEqual([
      'stripe',
      '~> 18.2',
    ]);
    expect(pick(samples.dependencies, 'dotenv')?.declared).toBeNull();
  });

  it('reads composer.json requirements without platform packages and composer.lock versions', async () => {
    const cashier = await parseFixture('php/cashier/composer.json');
    expect(cashier.dependencies.map((entry) => entry.name)).not.toContain('php');
    expect(cashier.dependencies.map((entry) => entry.name)).not.toContain('ext-json');
    expect(pick(cashier.dependencies, 'stripe/stripe-php')?.declared).toBe(
      '^17.4|^18.0|^19.0|^20.0|^21.0',
    );
    const inventory = await readPackageManifests(join(FIXTURES, 'php', 'monica'));
    expect(
      inventory.dependencies
        .filter((entry) => entry.locked)
        .map((entry) => [entry.name, entry.declared, entry.locked]),
    ).toEqual([
      ['guzzlehttp/guzzle', '^7.4', '7.9.3'],
      ['laravel/framework', '^12.0', '12.22.1'],
      ['laravel/socialite', '^5.5', '5.23.0'],
      ['phpunit/phpunit', '^11.0', '11.5.29'],
    ]);
  });

  it('reads pom.xml dependencies, resolving literal properties and stopping on the rest', async () => {
    const samples = await parseFixture('java/stripe-samples/pom.xml');
    expect(pick(samples.dependencies, 'com.stripe:stripe-java')).toMatchObject({
      ecosystem: 'maven',
      declared: '31.2.0',
      line: 30,
    });
    const twilio = await parseFixture('java/twilio-java/pom.xml');
    expect(twilio.dependencies).toHaveLength(26);
    expect(pick(twilio.dependencies, 'org.projectlombok:lombok')?.declared).toMatch(/^\d/);
    expect(pick(twilio.dependencies, 'com.fasterxml.jackson.core:jackson-databind')?.declared).toBe(
      '2.18.6',
    );
  });

  it('reads Gradle literal coordinates in both string and map forms, and version catalogs', async () => {
    const stripeJava = await parseFixture('java/stripe-java/build.gradle');
    expect(stripeJava.dependencies.map((entry) => [entry.name, entry.declared])).toEqual([
      ['com.google.code.gson:gson', '2.10.1'],
      ['com.google.guava:guava', '31.0.1-jre'],
      ['com.squareup.okhttp3:mockwebserver', '4.9.1'],
      ['org.mockito:mockito-core', '4.1.0'],
      ['org.junit.jupiter:junit-jupiter-api', '5.8.2'],
      ['org.junit.jupiter:junit-jupiter-engine', '5.8.2'],
      ['org.slf4j:slf4j-api', '1.7.32'],
    ]);
    // nowinandroid's build file references the catalog (libs.*), so it declares nothing literal.
    expect((await parseFixture('kotlin/nowinandroid/app/build.gradle.kts')).dependencies).toEqual(
      [],
    );
    const catalog = await parseFixture('kotlin/nowinandroid/gradle/libs.versions.toml');
    expect(catalog.dependencies).toHaveLength(103);
    expect(catalog.dependencies.every((entry) => entry.name.includes(':'))).toBe(true);
    expect(pick(catalog.dependencies, 'com.google.dagger:hilt-android')?.declared).toMatch(/^\d/);
  });

  it('reads .csproj PackageReferences with central versions from Directory.Packages.props', async () => {
    const samples = await parseFixture('dotnet/stripe-samples/server.csproj');
    expect(samples.dependencies.map((entry) => [entry.name, entry.declared, entry.line])).toEqual([
      ['DotNetEnv', '3.0.0', 9],
      ['Stripe.net', '51.0.0', 10],
    ]);
    const inventory = await readPackageManifests(join(FIXTURES, 'dotnet', 'eshop'));
    expect(inventory.stops).toEqual([]);
    expect(inventory.dependencies).toHaveLength(8);
    expect(inventory.dependencies.every((entry) => entry.declared && !entry.locked)).toBe(true);
  });

  it('reads Cargo dependencies, renames, workspace and path entries, and Cargo.lock versions', async () => {
    const inventory = await readPackageManifests(join(FIXTURES, 'rust'));
    const aichat = inventory.dependencies.filter((entry) => entry.file === 'aichat/Cargo.toml');
    expect(aichat).toHaveLength(64);
    expect(
      ['reqwest', 'serde', 'tokio', 'anyhow'].map((name) => {
        const dependency = aichat.find((entry) => entry.name === name)!;
        return [name, dependency.declared, dependency.locked];
      }),
    ).toEqual([
      ['reqwest', '0.12.0', '0.12.22'],
      ['serde', '1.0.152', '1.0.219'],
      ['tokio', '1.34.0', '1.46.1'],
      ['anyhow', '1.0.69', '1.0.98'],
    ]);
    expect(inventory.dependencies.find((entry) => entry.name === 'async-openai')).toMatchObject({
      declared: 'path:../../async-openai',
      file: 'async-openai/examples/chat/Cargo.toml',
    });
    const root = await repository({
      'Cargo.toml':
        '[workspace.dependencies]\nstripe = { package = "async-stripe", version = "0.41" }\n',
      'crates/app/Cargo.toml': '[dependencies]\nstripe.workspace = true\n',
      'Cargo.lock': '[[package]]\nname = "async-stripe"\nversion = "0.41.0"\n',
    });
    const workspace = await readPackageManifests(root);
    expect(
      workspace.dependencies.map((entry) => [entry.file, entry.name, entry.declared, entry.locked]),
    ).toEqual([
      ['Cargo.toml', 'async-stripe', '0.41', '0.41.0'],
      ['crates/app/Cargo.toml', 'stripe', 'workspace', null],
    ]);
  });
});

describe('stops and exclusions', () => {
  it('turns every malformed manifest into a named stop and keeps going', async () => {
    const root = await repository({
      'pyproject.toml': '[project]\ndependencies = ["stripe"\n',
      'Pipfile.lock': '{"default": ',
      'app/pom.xml': '<project><dependencies></project>',
      'app/build.gradle':
        'dependencies {\n  implementation "com.stripe:stripe-java:$stripeVersion"\n}\n',
      'service/Service.csproj':
        '<Project><ItemGroup><PackageReference Include="Stripe.net" Version="$(StripeVersion)" /></ItemGroup></Project>',
      'go.mod': 'module x\n\nrequire (\n\tgithub.com/stripe/stripe-go/v82 v82.0.0\n',
      Gemfile: "gem 'stripe', STRIPE_VERSION\n",
      'requirements-dev.txt': '-r ../outside.txt\n-r missing.txt\nopenai\n',
      'worker/Cargo.toml': '[dependencies]\nasync-openai = \n',
      'worker/composer.json': '["not an object"]',
    });
    const inventory = await readPackageManifests(root);
    expect(inventory.stops.map((entry) => [entry.file, entry.reason])).toEqual(
      expect.arrayContaining([
        ['pyproject.toml', 'unparseable-toml'],
        ['Pipfile.lock', 'unparseable-json'],
        ['app/pom.xml', 'unparseable-xml'],
        ['app/build.gradle', 'version-not-literal'],
        ['service/Service.csproj', 'version-not-literal'],
        ['go.mod', 'unparseable-manifest'],
        ['Gemfile', 'version-not-literal'],
        ['requirements-dev.txt', 'include-outside-repository'],
        ['requirements-dev.txt', 'include-missing'],
        ['worker/Cargo.toml', 'unparseable-toml'],
        ['worker/composer.json', 'unparseable-json'],
      ]),
    );
    expect(inventory.stops).toHaveLength(11);
    // Dependencies Refit could still read are kept, with no version where none is literal.
    expect(
      inventory.dependencies.map((entry) => [entry.ecosystem, entry.name, entry.declared]),
    ).toEqual(
      expect.arrayContaining([
        ['maven', 'com.stripe:stripe-java', null],
        ['nuget', 'Stripe.net', null],
        ['go', 'github.com/stripe/stripe-go/v82', 'v82.0.0'],
        ['rubygems', 'stripe', null],
        ['pypi', 'openai', null],
      ]),
    );
  });

  it('skips installed and build directories and oversized manifests', async () => {
    const root = await repository({
      'vendor/github.com/x/go.mod': 'module x\n',
      'node_modules/a/requirements.txt': 'stripe\n',
      '.venv/lib/requirements.txt': 'stripe\n',
      'target/Cargo.toml': '[dependencies]\nserde = "1"\n',
      'bin/Debug/app.csproj': '<Project />',
      'requirements.txt': `${'# padding\n'.repeat(450_000)}stripe\n`,
      'src/requirements.txt': 'openai==1.0.0\n',
    });
    const inventory = await readPackageManifests(root);
    expect(inventory.manifests.map((entry) => entry.file)).toEqual([
      'requirements.txt',
      'src/requirements.txt',
    ]);
    expect(inventory.stops).toEqual([
      {
        file: 'requirements.txt',
        line: null,
        reason: 'manifest-too-large',
        detail: 'Larger than 4 MiB; not read',
      },
    ]);
    expect(inventory.dependencies.map((entry) => entry.name)).toEqual(['openai']);
  });
});

it('detects catalog providers from non-JavaScript manifests through detectProviders', async () => {
  const root = await repository({
    'backend/requirements.txt': 'Stripe==12.0.0\nopenai>=1.40\n',
    'services/billing/go.mod':
      'module billing\n\nrequire github.com/stripe/stripe-go/v82 v82.1.0\nrequire github.com/twilio/twilio-go v1.20.0 // indirect\n',
    'services/billing/go.sum':
      'github.com/stripe/stripe-go/v82 v82.1.0 h1:abc=\ngithub.com/stripe/stripe-go/v82 v82.1.0/go.mod h1:def=\n',
    'web/Gemfile': "gem 'anthropic', '~> 1.0'\n",
    'web/Gemfile.lock': 'GEM\n  remote: https://rubygems.org/\n  specs:\n    anthropic (1.2.0)\n',
    'php/composer.json': '{"require": {"Twilio/SDK": "^8.0"}}',
    'jvm/pom.xml':
      '<project><dependencies><dependency><groupId>com.openai</groupId><artifactId>openai-java</artifactId><version>2.0.0</version></dependency></dependencies></project>',
    'dotnet/App.csproj':
      '<Project><ItemGroup><PackageReference Include="stripe.net" Version="47.0.0" /></ItemGroup></Project>',
    'rust/Cargo.toml': '[dependencies]\nresend-rs = "0.9"\n',
  });
  const detections = await detectProviders(root);
  expect(
    detections.map((entry) => [
      entry.agent.id,
      entry.packages.map((item) => `${item.ecosystem}:${item.name}@${item.locked ?? item.version}`),
    ]),
  ).toEqual([
    [
      'stripe',
      [
        'pypi:stripe@==12.0.0',
        'nuget:stripe.net@47.0.0',
        'go:github.com/stripe/stripe-go/v82@v82.1.0',
      ],
    ],
    ['openai', ['pypi:openai@>=1.40', 'maven:com.openai:openai-java@2.0.0']],
    ['anthropic', ['rubygems:anthropic@1.2.0']],
    ['twilio', ['packagist:twilio/sdk@^8.0']],
    ['resend', ['cargo:resend-rs@0.9']],
  ]);
  // The indirect Twilio Go module is not a detection; the direct Composer one is.
  expect(detections.find((entry) => entry.agent.id === 'twilio')?.packages).toHaveLength(1);
});

describe('SDKs past end of support in other ecosystems', () => {
  it('reports declarations of a registry sdk entry with an ecosystem, live or test', async () => {
    const root = await repository({
      'requirements.txt': 'google-generativeai==0.8.3\n',
      'tests/requirements.txt': 'Google_GenerativeAI>=0.7\n',
      'services/chat/go.mod': 'module chat\n\nrequire github.com/google/generative-ai-go v0.18.0\n',
      'services/chat/go.sum': 'github.com/google/generative-ai-go v0.18.0 h1:x=\n',
      // The new SDKs are not exposures.
      'api/pyproject.toml': '[project]\ndependencies = ["google-genai>=1"]\n',
    });
    const registry = await loadDeadlineRegistry();
    const scan = await scanDeadlines(root, registry, new Date('2026-10-22T00:00:00Z'));
    const exposures = scan.exposures.map((exposure) => [
      exposure.deadline.id,
      exposure.evidence.map((item) => `${item.file}:${item.line} ${item.use} ${item.text}`),
      exposure.nonLive.map((item) => `${item.file}:${item.line} ${item.use}`),
    ]);
    expect(exposures).toEqual([
      [
        'gemini-2025-11-30-generative-ai-go',
        [
          'services/chat/go.mod:3 live go:github.com/google/generative-ai-go v0.18.0 (locked) is declared in services/chat/go.mod',
        ],
        [],
      ],
      [
        'gemini-2025-11-30-google-generativeai-python',
        [
          'requirements.txt:1 live pypi:google-generativeai ==0.8.3 is declared in requirements.txt',
        ],
        ['tests/requirements.txt:1 test'],
      ],
    ]);
  });

  it('accepts ecosystem only on sdk entries and only for a known registry', () => {
    const entry = {
      id: 'x',
      provider: 'gemini',
      kind: 'sdk',
      versions: ['google-generativeai'],
      date: '2025-11-30',
      summary: 'Support ended.',
      replacement: null,
      source: 'https://example.com',
      checkedAt: '2026-10-22',
    };
    const check = (extra: Record<string, unknown>) =>
      checkDeadlineRegistry(
        { formatVersion: 1, deadlines: [{ ...entry, ...extra }] },
        new Date('2026-10-22T00:00:00Z'),
      ).errors;
    expect(check({ ecosystem: 'pypi' })).toEqual([]);
    expect(check({ ecosystem: 'npm' })).toEqual([
      'x: ecosystem is only for sdk entries and must be one of pypi, go, rubygems, packagist, maven, nuget, cargo.',
    ]);
    expect(check({ ecosystem: 'pypi', kind: 'model' })).toHaveLength(1);
  });
});
