// What every benchmark run records about itself and how it resumes: the harness record (Refit
// commit and tree state, list digest, options, Node and Docker versions), the dirty-tree gate,
// the checks a resumed run must pass, and which rows are infrastructure errors rather than
// results. See docs/BENCHMARK-HARNESS.md.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const COMMIT = /^[0-9a-f]{40}$/;
// `git archive` replaces this file's placeholder with the commit (see .gitattributes), so an
// exported tree such as an AWS shard's still knows which commit it is.
export const COMMIT_STAMP = 'scripts/benchmark-commit.txt';
const sha256 = (content) => createHash('sha256').update(content).digest('hex');

async function git(root, ...args) {
  return (await execute('git', ['-C', root, ...args], { maxBuffer: 256 * 1024 * 1024 })).stdout;
}

// The Refit commit at `root`, and the tracked changes on top of it. A tree with tracked changes,
// or whose commit cannot be told, is refused unless allowDirty is set; untracked files are not
// counted, as in `git describe --dirty`.
export async function refitRevision(root, { allowDirty = false } = {}) {
  const toplevel = await git(root, 'rev-parse', '--show-toplevel').then(
    (output) => output.trim(),
    () => undefined,
  );
  if (toplevel && realpathSync(toplevel) === realpathSync(root)) {
    const commit = (await git(root, 'rev-parse', 'HEAD')).trim();
    const files = (await git(root, 'diff', 'HEAD', '--name-only', '-z'))
      .split('\0')
      .filter(Boolean)
      .sort();
    const dirty = files.length
      ? { files, sha256: sha256(await git(root, 'diff', 'HEAD', '--binary')) }
      : null;
    if (dirty && !allowDirty)
      throw new Error(
        `Refusing to benchmark a dirty tree: ${files.length} tracked file(s) differ from ${commit.slice(0, 12)} (${files.slice(0, 5).join(', ')}${files.length > 5 ? ', ...' : ''}). Commit them, or pass --allow-dirty to record the run as dirty.`,
      );
    return { commit, source: 'git', dirty, allowDirty };
  }
  const stamp = await readFile(join(root, COMMIT_STAMP), 'utf8').then(
    (content) => content.trim(),
    () => '',
  );
  if (COMMIT.test(stamp)) return { commit: stamp, source: 'archive', dirty: null, allowDirty };
  if (!allowDirty)
    throw new Error(
      `Cannot tell which Refit commit ${root} is: it is not a git checkout, and ${COMMIT_STAMP} was not stamped by git archive. Pass --allow-dirty to run anyway; the record will have no commit.`,
    );
  return { commit: null, source: 'unknown', dirty: null, allowDirty };
}

// The Docker server version and the image's immutable ID and registry digests.
export async function dockerVersions(image) {
  try {
    const version = (
      await execute('docker', ['version', '--format', '{{.Server.Version}}'])
    ).stdout.trim();
    const inspected = JSON.parse(
      (await execute('docker', ['image', 'inspect', '--format', '{{json .}}', image])).stdout,
    );
    return {
      version,
      image,
      imageId: inspected.Id,
      repoDigests: [...(inspected.RepoDigests ?? [])].sort(),
    };
  } catch (error) {
    throw new Error(
      `This run uses Docker, but the Docker version or image ${image} could not be read: ${String(error.stderr || error.message).trim()}`,
    );
  }
}

// Keys in sorted order, recursively, so equal options serialize equally.
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
}

// The harness record for a new run. `list.file` is hashed and recorded under `list.path`;
// `options` are the command-line values that can change outcomes, and `environment` names the
// variables that can (never a secret); `image` is set when the run uses Docker.
export async function startRun({
  format,
  refitRoot,
  list,
  options,
  environment: names = [],
  image,
  allowDirty,
}) {
  const environment = Object.fromEntries(
    names.filter((name) => process.env[name]).map((name) => [name, process.env[name]]),
  );
  const values = Object.fromEntries(
    Object.entries({
      ...options,
      ...(Object.keys(environment).length ? { environment } : {}),
    }).filter(([, value]) => value !== undefined && value !== false),
  );
  return {
    formatVersion: 1,
    format,
    refit: await refitRevision(refitRoot, { allowDirty }),
    list: { path: list.path, sha256: sha256(await readFile(list.file)) },
    options: sorted(values),
    node: process.version,
    docker: image ? await dockerVersions(image) : null,
    startedAt: new Date().toISOString(),
  };
}

// Why `current` may not continue `previous`, or an empty list when it may: the same format, a
// known Refit commit with the same uncommitted changes, the same list and the same options.
export function resumeMismatches(previous, current) {
  const differences = [];
  if (previous.format !== current.format) differences.push('format');
  if (!previous.refit?.commit || !current.refit.commit) differences.push('unknown Refit commit');
  else if (previous.refit.commit !== current.refit.commit) differences.push('Refit commit');
  if ((previous.refit?.dirty?.sha256 ?? null) !== (current.refit.dirty?.sha256 ?? null))
    differences.push('uncommitted changes');
  if (previous.list?.sha256 !== current.list.sha256) differences.push('list');
  if (JSON.stringify(sorted(previous.options)) !== JSON.stringify(sorted(current.options)))
    differences.push('options');
  return differences;
}

function refuseResume(where, previous, harness) {
  const differences = resumeMismatches(previous, harness);
  if (differences.length)
    throw new Error(
      `Refusing to resume ${where}: ${differences.join(', ')} differ from the run it started. Use a new output.`,
    );
  return {
    ...previous,
    resumes: [
      ...(previous.resumes ?? []),
      { startedAt: harness.startedAt, node: harness.node, docker: harness.docker },
    ],
  };
}

export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// A Stripe or Shopify output directory: results.json plus harness.json. Without `resume` the
// directory must be new. With it, an existing directory must hold the same run; its rows are
// returned so finished repositories can be skipped, and the record notes the resume.
export async function openRunDirectory(output, harness, { resume = false } = {}) {
  if (!resume || !existsSync(output)) {
    await mkdir(output);
    await writeFile(join(output, 'harness.json'), json(harness));
    return { harness, rows: [] };
  }
  const recorded = await readFile(join(output, 'harness.json'), 'utf8').catch(() => {
    throw new Error(`Cannot resume ${output}: it has no harness.json.`);
  });
  const resumed = refuseResume(output, JSON.parse(recorded), harness);
  const rows = await readFile(join(output, 'results.json'), 'utf8').then(JSON.parse, () => []);
  await writeFile(join(output, 'harness.json'), json(resumed));
  return { harness: resumed, rows };
}

// A results file holding `{ harness, results }` (the AI-app and deadline benchmarks). Without
// `resume` the run starts empty; with it, an existing file must hold the same run.
export async function openResultsFile(path, harness, { resume = false } = {}) {
  if (!resume || !existsSync(path)) return { harness, rows: [] };
  const recorded = JSON.parse(await readFile(path, 'utf8'));
  if (!recorded.harness) throw new Error(`Cannot resume ${path}: it has no harness record.`);
  return { harness: refuseResume(path, recorded.harness, harness), rows: recorded.results ?? [] };
}

// A resumed run keeps a previous row only when it is a finished repository result for the same
// repository and commit; infrastructure errors and unfinished rows run again.
export const finishedRow = (row, entry) =>
  Boolean(
    row &&
    row.repo === entry.repo &&
    row.commit === entry.commit &&
    row.outcomeClass === 'repository',
  );

// Why `directory` is not a checkout of `commit`, or undefined when it is. A failed shallow fetch
// leaves an empty `git init`, which would otherwise scan as a repository that uses nothing.
export async function checkoutError(directory, commit) {
  if (!existsSync(directory)) return `no checkout at ${directory}`;
  const head = await git(directory, 'rev-parse', '--show-toplevel', 'HEAD').then(
    (output) => output.trim().split('\n'),
    () => undefined,
  );
  if (!head || realpathSync(head[0]) !== realpathSync(directory))
    return 'the directory is not a checkout with a commit of its own (the fetch failed)';
  if (head[1] !== commit) return `the checkout is at ${head[1]}, not the pinned ${commit}`;
  return undefined;
}

const DOCKER_FAILURE =
  /Cannot connect to the Docker daemon|Is the docker daemon running|error during connect|Error response from daemon|No such image|spawn docker ENOENT|Docker did not resolve a unique immutable image ID/;
// Network failures while dependency preparation downloads from the registry, and preparation
// running out of time. Validation itself is offline, so these come only from preparation. Yarn's
// "trouble with your network connection. Retrying..." is a notice, not the failure, so it is not
// one of them.
const REGISTRY_FAILURE =
  /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ESOCKETTIMEDOUT|ERR_SOCKET_TIMEOUT|EHOSTUNREACH|ENETUNREACH)\b|network request to \S+ failed|ERR_PNPM_META_FETCH_FAIL|^Dependency preparation exceeded \d+ seconds/m;
// A dependency tree that fills the sandbox workspace is the repository's size against Refit's
// limit, whatever network notices come with it.
const WORKSPACE_FULL = /\bENOSPC\b/;
const firstLine = (text, pattern) =>
  text
    .split('\n')
    .find((line) => pattern.test(line))
    ?.trim()
    .slice(0, 300) ?? text.slice(0, 300);

// The infrastructure error behind a `refit run` workflow summary, if any.
function workflowInfrastructure(workflow) {
  if (!workflow) return undefined;
  if (workflow.status === 'missing-manifest')
    return {
      kind: 'no-manifest',
      message:
        'The workflow wrote no manifest: the harness time limit killed it, or it crashed, so it has no outcome.',
    };
  const text = [workflow.error, workflow.reason].filter(Boolean).join('\n');
  if (DOCKER_FAILURE.test(text))
    return { kind: 'docker', message: firstLine(text, DOCKER_FAILURE) };
  if (REGISTRY_FAILURE.test(text) && !WORKSPACE_FULL.test(text))
    return { kind: 'registry', message: firstLine(text, REGISTRY_FAILURE) };
  return undefined;
}

// Whether a row is Refit's result on the repository or an infrastructure error, from the row's
// own fields, so rows written before the harness recorded it can be classified too. A row the
// harness already marked keeps its detail.
export function classifyRow(format, row) {
  let infrastructure = row.infrastructure;
  if (!infrastructure)
    switch (format) {
      case 'stripe-results':
      case 'shopify-results':
        infrastructure =
          typeof row.read === 'string' && /\bENOENT\b/.test(row.read)
            ? { kind: 'clone', message: row.read.slice(0, 300) }
            : workflowInfrastructure(row.workflow);
        break;
      case 'ai-model-results':
      case 'deadline-results':
      case 'meta-graph-results':
        if (typeof row.error === 'string' && row.error.startsWith('checkout: '))
          infrastructure = { kind: 'clone', message: row.error.slice(0, 300) };
        break;
      default:
        throw new Error(`Unknown results format "${format}".`);
    }
  return infrastructure
    ? { outcomeClass: 'infrastructure', infrastructure }
    : { outcomeClass: 'repository' };
}

// Rows classified, with infrastructure errors split out, for summaries that count only results.
export function splitRows(format, rows) {
  const classified = rows.map((row) => ({ ...row, ...classifyRow(format, row) }));
  return {
    results: classified.filter((row) => row.outcomeClass === 'repository'),
    infrastructure: classified.filter((row) => row.outcomeClass === 'infrastructure'),
  };
}
