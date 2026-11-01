import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const backend = [
  'app',
  'inventory',
  'harness',
  'memory',
  'providers',
  'evals',
  'shared',
  'orchestrator',
];

export default defineConfig({
  plugins: [react()],
  test: {
    restoreMocks: true,
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'website',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'backend',
          include: backend.map((folder) => `${folder}/**/*.test.ts`),
          exclude: ['**/node_modules/**'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
    ],
  },
});
