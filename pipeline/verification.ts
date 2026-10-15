import { MAX_VALIDATION_ARCHIVE_BYTES } from './docker-sandbox.ts';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const MANIFEST = 'manifest.json';
const MAX_MANIFEST_BYTES = 64 * 1024;
// A dependency archive is the largest artifact; other files are bounded far below it.
const MAX_ARTIFACT_BYTES = MAX_VALIDATION_ARCHIVE_BYTES;
const MAX_TOTAL_BYTES = MAX_VALIDATION_ARCHIVE_BYTES + 64 * 1024 * 1024;
const MAX_FILES = 16;
const HASH = /^[a-f0-9]{64}$/;
const FILE_NAME = /^[a-z][a-z0-9.-]*$/;
const KINDS = new Set([
  'refit-workflow',
  'refit-review-bundle',
  'refit-stripe-check',
  'refit-npm-environment',
  'refit-pnpm-environment',
  'refit-yarn-environment',
]);

export async function inspectArtifactFile(path: string, limit: number, retainContent = false) {
  if (!(await lstat(path)).isFile())
    throw new PipelineInputError('Evidence must contain regular files, not links or directories.');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > limit)
      throw new PipelineInputError(
        'Evidence file exceeds its size limit or is not a regular file.',
      );
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end: limit })) {
      bytes += chunk.length;
      if (bytes > limit) throw new PipelineInputError('Evidence file exceeds its size limit.');
      hash.update(chunk);
      if (retainContent) chunks.push(chunk);
    }
    return { bytes, sha256: hash.digest('hex'), content: Buffer.concat(chunks).toString('utf8') };
  } finally {
    await file.close();
  }
}

export async function verifyArtifacts(directory: string) {
  const root = await realpath(directory);
  const manifestFile = await inspectArtifactFile(join(root, MANIFEST), MAX_MANIFEST_BYTES, true);
  const manifest = parseObject(manifestFile.content, MANIFEST);
  if (
    manifest.formatVersion !== 1 ||
    typeof manifest.kind !== 'string' ||
    !KINDS.has(manifest.kind) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > MAX_FILES
  )
    throw new PipelineInputError('Unsupported evidence manifest format, kind or file count.');
  const files: { path: string; sha256: string; bytes: number }[] = [];
  const names = new Set([MANIFEST]);
  let totalBytes = 0;
  for (const entry of manifest.files) {
    if (
      !isObject(entry) ||
      typeof entry.path !== 'string' ||
      !FILE_NAME.test(entry.path) ||
      names.has(entry.path) ||
      typeof entry.sha256 !== 'string' ||
      !HASH.test(entry.sha256) ||
      typeof entry.bytes !== 'number' ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > MAX_ARTIFACT_BYTES
    )
      throw new PipelineInputError('Invalid or duplicate artifact entry in evidence manifest.');
    names.add(entry.path);
    totalBytes += entry.bytes;
    if (totalBytes > MAX_TOTAL_BYTES)
      throw new PipelineInputError('Evidence exceeds the total size limit.');
    files.push({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes });
  }
  const unexpected = (await readdir(root)).filter((name) => !names.has(name));
  if (unexpected.length)
    throw new PipelineInputError(`Unlisted evidence entries: ${unexpected.join(', ')}`);
  for (const entry of files) {
    const actual = await inspectArtifactFile(join(root, entry.path), entry.bytes);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256)
      throw new PipelineInputError(`Evidence hash or byte count mismatch: ${entry.path}`);
  }
  return {
    status: 'integrity-verified',
    directory: root,
    kind: manifest.kind,
    manifestHash: manifestFile.sha256,
    files: files.length,
    bytes: totalBytes,
    scope:
      'Declared file bytes match this unsigned manifest. This does not authenticate the producer, prove manifest completeness, validate migration semantics or rerun checks.',
  };
}
