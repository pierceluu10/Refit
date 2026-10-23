// Checks every non-npm package name in the agent catalog (`ecosystems`) against its registry and
// records what the registry says the package is: its latest version and the source or project URL
// it links. A reviewer reads that URL to confirm the package belongs to the provider. Nothing is
// downloaded beyond registry metadata, and nothing is installed or run.
//
//   node scripts/catalog-registry-check.mjs --output docs/benchmarks/<date>-catalog-registry-check.json
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { AGENT_CATALOG } from '../pipeline/agent-catalog.ts';

const USER_AGENT = 'refit-catalog-registry-check (https://github.com/pierceluu10/Refit)';
const { values } = parseArgs({ options: { output: { type: 'string' } } });

async function json(url) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    // Maven Central rate-limits bursts; wait and retry a few times.
    if (response.status === 429 && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
      continue;
    }
    if (!response.ok) return { status: response.status };
    const type = response.headers.get('content-type') ?? '';
    return {
      status: response.status,
      body: type.includes('json') ? await response.json() : await response.text(),
    };
  }
}

const REGISTRIES = {
  async pypi(name) {
    const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
    const { status, body } = await json(url);
    const urls = body?.info?.project_urls ?? {};
    const source = Object.values(urls).find((item) => /github\.com|gitlab\.com/.test(item));
    return { url, status, latest: body?.info?.version, source: source ?? body?.info?.home_page };
  },
  async go(name) {
    const url = `https://proxy.golang.org/${name.toLowerCase().replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)}/@latest`;
    const { status, body } = await json(url);
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    return { url, status, latest: parsed?.Version, source: parsed?.Origin?.URL };
  },
  async rubygems(name) {
    const url = `https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`;
    const { status, body } = await json(url);
    return {
      url,
      status,
      latest: body?.version,
      source: body?.source_code_uri ?? body?.homepage_uri,
    };
  },
  async packagist(name) {
    const url = `https://repo.packagist.org/p2/${name.toLowerCase()}.json`;
    const { status, body } = await json(url);
    const latest = body?.packages?.[name.toLowerCase()]?.[0];
    return { url, status, latest: latest?.version, source: latest?.source?.url };
  },
  async maven(name) {
    const [group, artifact] = name.split(':');
    const url = `https://repo1.maven.org/maven2/${group.replace(/\./g, '/')}/${artifact}/maven-metadata.xml`;
    const { status, body } = await json(url);
    const latest = /<release>([^<]+)<\/release>/.exec(body ?? '')?.[1];
    let source;
    if (latest) {
      const pom = await json(
        url.replace('maven-metadata.xml', `${latest}/${artifact}-${latest}.pom`),
      );
      source =
        /<scm>[\s\S]*?<url>([^<]+)<\/url>/.exec(pom.body ?? '')?.[1] ??
        /<url>([^<]+)<\/url>/.exec(pom.body ?? '')?.[1];
    }
    return { url, status, latest, source };
  },
  async nuget(name) {
    const url = `https://api.nuget.org/v3/registration5-gz-semver2/${name.toLowerCase()}/index.json`;
    const { status, body } = await json(url);
    const pages = body?.items ?? [];
    const lastPage = pages.at(-1);
    const items =
      lastPage?.items ?? (lastPage ? (await json(lastPage['@id'])).body?.items : []) ?? [];
    const entry = items.at(-1)?.catalogEntry;
    return { url, status, latest: entry?.version, source: entry?.projectUrl };
  },
  async cargo(name) {
    const url = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`;
    const { status, body } = await json(url);
    return {
      url,
      status,
      latest: body?.crate?.max_stable_version,
      source: body?.crate?.repository,
    };
  },
};

const checks = [];
for (const agent of AGENT_CATALOG)
  for (const [ecosystem, names] of Object.entries(agent.ecosystems ?? {}))
    for (const name of names) {
      const result = await REGISTRIES[ecosystem](name);
      checks.push({ provider: agent.id, ecosystem, name, ...result });
      console.error(
        `${result.status} ${ecosystem}:${name} ${result.latest ?? ''} ${result.source ?? ''}`,
      );
    }
const report = { formatVersion: 1, checkedAt: new Date().toISOString(), checks };
if (values.output) await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
if (checks.some((check) => check.status !== 200)) process.exitCode = 1;
