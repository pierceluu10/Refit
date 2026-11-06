// Container images: the Dockerfile names the new base image and still builds on it. The build runs
// with `docker build` on the host: every RUN step executes inside a build container, which is the
// sandbox for this check, and the build context is the sandbox's copy (no real env files). Without a
// Docker daemon the build is skipped and the result says so.
import { randomBytes } from 'node:crypto';
import { createSandbox } from '../sandbox.ts';
import type { ProofCheck } from './types.ts';
import {
  execLog,
  hostExec,
  lineOf,
  optBoolean,
  optString,
  optStrings,
  proofDetail,
  readText,
  walkFiles,
} from './util.ts';

export type FromLine = { file: string; line: number; image: string; stage?: string };

export function parseFromLines(file: string, text: string): FromLine[] {
  const out: FromLine[] = [];
  const joined = text.replace(/\\\r?\n/g, ' ');
  for (const match of joined.matchAll(
    /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/gim,
  ))
    out.push({ file, line: lineOf(joined, match.index ?? 0), image: match[1], stage: match[2] });
  return out;
}

// node:22-bookworm matches node:22-bookworm and docker.io/library/node:22-bookworm; a digest pin counts
// when the repository and tag match.
export function sameImage(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .replace(/^docker\.io\//, '')
      .replace(/^library\//, '')
      .replace(/@sha256:[a-f0-9]+$/, '')
      .toLowerCase();
  return norm(a) === norm(b);
}

export const containerImageCheck: ProofCheck = {
  name: 'container-image',
  description:
    'Check that each Dockerfile is on the target base image and still builds on it with `docker build` (RUN steps run in build containers). Skips the build cleanly without a Docker daemon. Returns evidence, never blocks.',
  inputSchema: {
    type: 'object',
    properties: {
      image: { type: 'string', description: 'The new base image, e.g. "node:22-bookworm"' },
      dockerfiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Dockerfiles to check, relative. Default: every Dockerfile',
      },
      buildArgs: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Build arguments, e.g. { "NODE_VERSION": "22" }',
      },
      build: { type: 'boolean', description: 'Run docker build. Default true' },
    },
  },
  run: async (input, ctx) => {
    const target = optString(input, 'image');
    const wantBuild = optBoolean(input, 'build') ?? true;
    const exec = ctx.hostExec ?? hostExec;
    // The build context must hold no real env files, so it is always a sandbox copy.
    const copy = ctx.sandbox
      ? undefined
      : await createSandbox(ctx.repoDir, { mode: 'local' }).catch(() => undefined);
    const root = ctx.sandbox?.dir ?? copy?.dir;
    try {
      if (!root)
        return proofDetail('container-image', {
          skipped: 'could not make a copy of the repo for the build context',
        });
      const given = optStrings(input, 'dockerfiles');
      const dockerfiles = given.length
        ? given
        : (await walkFiles(root)).filter((f) =>
            /(^|\/)(Dockerfile|Containerfile)(\.[\w-]+)?$|\.dockerfile$/i.test(f),
          );
      const passedItems: string[] = [];
      const failedItems: string[] = [];
      const notes: string[] = [];
      const commands: string[] = [];
      let logTail: string | undefined;
      let skipped: string | undefined;
      const froms: FromLine[] = [];
      for (const file of dockerfiles) {
        const text = await readText(root, file);
        if (text === undefined) {
          failedItems.push(`${file} not found`);
          continue;
        }
        froms.push(...parseFromLines(file, text));
      }
      const stages = new Set(froms.map((f) => f.stage?.toLowerCase()).filter(Boolean));
      for (const from of froms) {
        const where = `${from.file}:${from.line} FROM ${from.image}`;
        if (stages.has(from.image.toLowerCase()) || from.image === 'scratch') continue;
        if (from.image.includes('$'))
          notes.push(`${where} is set by a build argument; check its default`);
        else if (target && sameImage(from.image, target))
          passedItems.push(`${where} is the target image`);
        else if (target) notes.push(`${where} is not ${target}`);
        else notes.push(where);
      }
      if (target && froms.length && !froms.some((f) => sameImage(f.image, target)))
        failedItems.push(`no Dockerfile stage is on ${target}`);

      if (wantBuild && dockerfiles.length) {
        const info = await exec('docker', ['info', '--format', '{{.ServerVersion}}'], {
          timeoutMs: 20_000,
        });
        if (info.code !== 0) skipped = 'no Docker daemon, so the images were not built';
        else {
          const buildArgs =
            input.buildArgs && typeof input.buildArgs === 'object'
              ? Object.entries(input.buildArgs as Record<string, unknown>).filter(
                  ([, v]) => typeof v === 'string',
                )
              : [];
          for (const file of dockerfiles) {
            const tag = `refit-proof-${randomBytes(4).toString('hex')}`;
            const args = [
              'build',
              '--pull',
              '--progress=plain',
              '-f',
              file,
              '-t',
              tag,
              ...buildArgs.flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]),
              '.',
            ];
            commands.push(`docker ${args.join(' ')}`);
            const result = await exec('docker', args, { cwd: root, timeoutMs: 30 * 60 * 1000 });
            logTail = execLog(result);
            if (result.code === 0) passedItems.push(`${file} builds`);
            else failedItems.push(`${file} does not build (exit ${result.code})`);
            await exec('docker', ['image', 'rm', '-f', tag], { timeoutMs: 60_000 });
          }
        }
      } else if (!wantBuild) notes.push('build: false, so the images were not built');
      if (dockerfiles.length === 0) notes.push('no Dockerfile found');
      return proofDetail('container-image', {
        commands,
        passedItems,
        failedItems,
        notes: skipped ? [skipped, ...notes] : notes,
        logTail,
        ...(dockerfiles.length === 0 ? { passed: 'unknown' as const } : {}),
        // Without a build the image change is unproven, even when the FROM line is right.
        ...(skipped && failedItems.length === 0 ? { passed: 'unknown' as const } : {}),
      });
    } finally {
      await copy?.dispose().catch(() => undefined);
    }
  },
};
