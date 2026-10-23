import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'frontend',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          // The open-handle check comes first so that its after-hooks run after cleanup unmounts.
          setupFiles: ['./pipeline/test/setup.ts', './src/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'pipeline',
          include: ['pipeline/*.test.ts', 'pipeline/python/*.test.ts', 'pipeline/go/*.test.ts'],
          environment: 'node',
          // Many pipeline tests start the CLI as a subprocess or run the TypeScript compiler; on a
          // loaded runner they take longer than vitest's 5 s default.
          testTimeout: 30_000,
          setupFiles: ['./pipeline/test/setup.ts'],
        },
      },
    ],
  },
});
