import { rm } from 'node:fs/promises';
import { afterEach, vi } from 'vitest';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
