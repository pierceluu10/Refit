import { rm } from 'node:fs/promises';
import { afterEach, vi } from 'vitest';

vi.mock('./validation.ts', () => ({ validateMigration: vi.fn() }));
vi.mock('./publication.ts', async (original) => ({
  ...(await original<typeof import('./publication.ts')>()),
  publishDraft: vi.fn(async () => ({ status: 'created', url: 'https://github.com/o/r/pull/1' })),
}));

const roots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
