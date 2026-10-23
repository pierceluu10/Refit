// Selects the frozen multi-ecosystem sample for the package inventory benchmark
// (docs/PACKAGE-INVENTORY.md). GitHub search is not reachable from where this ran, so candidates
// come from each ecosystem's public reverse-dependency listing of catalog SDKs, or from GitLab
// project search where the registry has none (PyPI and Maven Central):
//
//   go         pkg.go.dev "Imported by" for each catalog Go module
//   rubygems   rubygems.org reverse_dependencies.json for each catalog gem
//   packagist  packagist.org dependents.json (by downloads) for each catalog package
//   cargo      crates.io reverse_dependencies for each catalog crate
//   nuget      the "GitHub Usage" list on each catalog package's nuget.org page
//   pypi       gitlab.com projects search, with_programming_language=Python, per provider keyword
//   maven      gitlab.com projects search, with_programming_language=Java and Kotlin
//
// Candidates are taken round-robin across the queries in the order each listing returns them,
// deduplicated, without the SDK vendors' own repositories, forks or archived projects, and kept
// once a shallow clone succeeds, until each ecosystem has its count. The listings move: the
// frozen file, not a rerun, is the reproducible record. Nothing in a clone is installed or run.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const USER_AGENT = 'refit-package-inventory-select (https://github.com/pierceluu10/Refit)';
const { values } = parseArgs({
  options: { output: { type: 'string' }, work: { type: 'string' } },
});
if (!values.output || !values.work)
  throw new Error('Usage: package-inventory-select.mjs --output <frozen.json> --work <clone dir>');

// The SDK vendors' own organisations: their repositories are the SDKs, not users of them.
const VENDORS =
  /^(stripe|stripe-samples|openai|anthropics|twilio|twilio-labs|sendgrid|resend|resendlabs|paypal|googleapis|google|google-gemini|shopify|facebook|64bit|arlyon|sashabaranov|alexrudall|openai-php|tghamm)$/i;
const COUNTS = { pypi: 15, go: 15, rubygems: 15, packagist: 15, maven: 10, nuget: 15, cargo: 15 };
const KEYWORDS = ['stripe', 'openai', 'anthropic', 'twilio', 'sendgrid', 'gemini'];

async function get(url, type = 'json') {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return type === 'json' ? response.json() : response.text();
}

function githubRepository(url) {
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i.exec(url ?? '');
  return match ? { host: 'github.com', path: `${match[1]}/${match[2]}` } : undefined;
}

const SOURCES = {
  async go() {
    const modules = [
      'github.com/stripe/stripe-go/v82',
      'github.com/openai/openai-go',
      'github.com/sashabaranov/go-openai',
      'github.com/anthropics/anthropic-sdk-go',
      'github.com/twilio/twilio-go',
      'github.com/sendgrid/sendgrid-go',
      'google.golang.org/genai',
    ];
    return Promise.all(
      modules.map(async (module) => {
        const url = `https://pkg.go.dev/${module}?tab=importedby`;
        const html = await get(url, 'text');
        const found = [...html.matchAll(/href="\/(github\.com\/[\w.-]+\/[\w.-]+)[^"]*"/g)].map(
          (match) => githubRepository(`https://${match[1]}`),
        );
        return { query: url, candidates: found };
      }),
    );
  },
  async rubygems() {
    const gems = ['stripe', 'openai', 'ruby-openai', 'anthropic', 'twilio-ruby', 'sendgrid-ruby'];
    return Promise.all(
      gems.map(async (gem) => {
        const url = `https://rubygems.org/api/v1/gems/${gem}/reverse_dependencies.json`;
        const names = (await get(url)).slice(0, 40);
        const candidates = [];
        for (const name of names) {
          const metadata = await get(`https://rubygems.org/api/v1/gems/${name}.json`).catch(
            () => undefined,
          );
          candidates.push(githubRepository(metadata?.source_code_uri ?? metadata?.homepage_uri));
        }
        return { query: url, candidates };
      }),
    );
  },
  async packagist() {
    const packages = ['stripe/stripe-php', 'openai-php/client', 'twilio/sdk', 'sendgrid/sendgrid'];
    return Promise.all(
      packages.map(async (name) => {
        const url = `https://packagist.org/packages/${name}/dependents.json?order_by=downloads`;
        const dependents = (await get(url)).packages.slice(0, 30);
        const candidates = [];
        for (const dependent of dependents) {
          const metadata = await get(`https://repo.packagist.org/p2/${dependent.name}.json`).catch(
            () => undefined,
          );
          candidates.push(githubRepository(metadata?.packages?.[dependent.name]?.[0]?.source?.url));
        }
        return { query: url, candidates };
      }),
    );
  },
  async cargo() {
    const crates = ['async-openai', 'async-stripe', 'resend-rs'];
    return Promise.all(
      crates.map(async (crate) => {
        const url = `https://crates.io/api/v1/crates/${crate}/reverse_dependencies?per_page=50`;
        const body = await get(url);
        const names = [...new Set(body.versions.map((version) => version.crate))];
        const candidates = [];
        for (const name of names.slice(0, 30)) {
          const metadata = await get(`https://crates.io/api/v1/crates/${name}`).catch(
            () => undefined,
          );
          candidates.push(githubRepository(metadata?.crate?.repository));
        }
        return { query: url, candidates };
      }),
    );
  },
  async nuget() {
    const packages = ['Stripe.net', 'OpenAI', 'Twilio', 'SendGrid', 'Anthropic.SDK'];
    return Promise.all(
      packages.map(async (name) => {
        const url = `https://www.nuget.org/packages/${name}`;
        const html = await get(url, 'text');
        // The "GitHub Usage" table links each repository as https://github.com/<owner>/<repo>.
        const section = html.slice(html.indexOf('id="used-by"'));
        const candidates = [
          ...section.matchAll(
            /class="[^"]*gh-link" href="https:\/\/github\.com\/([\w.-]+\/[\w.-]+)"/g,
          ),
        ].map((match) => githubRepository(`https://github.com/${match[1]}`));
        return { query: `${url} (GitHub Usage)`, candidates };
      }),
    );
  },
  async pypi() {
    return gitlab(['Python']);
  },
  async maven() {
    return gitlab(['Java', 'Kotlin']);
  },
};

async function gitlab(languages) {
  const queries = [];
  for (const language of languages)
    for (const keyword of KEYWORDS) {
      const url = `https://gitlab.com/api/v4/projects?search=${keyword}&with_programming_language=${language}&order_by=star_count&sort=desc&per_page=40`;
      const projects = await get(url);
      queries.push({
        query: url,
        candidates: projects
          // Unauthenticated listings omit fork and archive flags; GitLab's own mirror groups of
          // GitHub projects are named *-forks or mirror*.
          .filter(
            (project) => !/(^|\/)[\w-]*(forks?|mirrors?)(\/|$)/i.test(project.path_with_namespace),
          )
          .map((project) => ({ host: 'gitlab.com', path: project.path_with_namespace })),
      });
    }
  return queries;
}

async function clone(candidate) {
  const directory = join(values.work, candidate.host, candidate.path);
  if (!existsSync(join(directory, '.git'))) {
    await mkdir(directory, { recursive: true });
    await execute(
      'git',
      [
        'clone',
        '--depth',
        '1',
        '--no-recurse-submodules',
        '--quiet',
        `https://${candidate.host}/${candidate.path}.git`,
        directory,
      ],
      {
        timeout: 300_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
      },
    );
  }
  const { stdout } = await execute('git', ['-C', directory, 'rev-parse', 'HEAD']);
  const { stdout: date } = await execute('git', ['-C', directory, 'log', '-1', '--format=%cI']);
  return { commit: stdout.trim(), committedAt: date.trim() };
}

const repositories = [];
const queries = [];
const rejected = [];
const seen = new Set();
for (const [ecosystem, count] of Object.entries(COUNTS)) {
  const listings = await SOURCES[ecosystem]();
  queries.push(
    ...listings.map((listing) => ({
      ecosystem,
      query: listing.query,
      candidates: listing.candidates.length,
    })),
  );
  let kept = 0;
  for (let index = 0; kept < count; index += 1) {
    const round = listings.map((listing) => listing.candidates[index]);
    if (listings.every((listing) => index >= listing.candidates.length)) break;
    for (const candidate of round) {
      if (!candidate || kept >= count) continue;
      const key = `${candidate.host}/${candidate.path}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (VENDORS.test(candidate.path.split('/')[0])) {
        rejected.push({ ecosystem, repository: key, reason: 'sdk-vendor' });
        continue;
      }
      try {
        const pinned = await clone(candidate);
        repositories.push({
          ecosystem,
          host: candidate.host,
          repository: candidate.path,
          ...pinned,
        });
        kept += 1;
        console.error(`${ecosystem} ${kept}/${count} ${key}`);
      } catch (error) {
        rejected.push({
          ecosystem,
          repository: key,
          reason: `clone: ${String(error.message).split('\n')[0]}`,
        });
      }
    }
  }
}

await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      selectedAt: new Date().toISOString(),
      method:
        'Reverse-dependency listings of catalog SDKs (pkg.go.dev, rubygems.org, packagist.org, crates.io, nuget.org GitHub Usage) and gitlab.com project search for PyPI and Maven, round-robin across queries in listing order, deduplicated, SDK vendor organisations, forks and archived projects removed, kept once a shallow clone succeeded. Provider exposure is never consulted.',
      counts: COUNTS,
      queries,
      rejected,
      repositories,
    },
    null,
    2,
  )}\n`,
);
