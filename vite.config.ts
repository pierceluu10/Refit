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
          setupFiles: ['./src/test/setup.ts'],
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
        },
      },
    ],
  },
});
