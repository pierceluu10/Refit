import react from '@vitejs/plugin-react';
import type { ProxyOptions } from 'vite';
import { loadEnv } from 'vite';
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
  'compliance',
];

const DEFAULT_APP_URL = 'http://127.0.0.1:3000';

// The service token is added here, on the dev server, so it never reaches browser code. Only
// VITE_-prefixed variables are exposed to the client, and this isn't one.
export function devProxy(env: Record<string, string>): Record<string, ProxyOptions> {
  const token = env.REFIT_SERVICE_TOKEN;
  return {
    '/api': {
      target: env.REFIT_APP_URL || DEFAULT_APP_URL,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // app/.env holds the app's credentials on a laptop that runs it; see app/SETUP.md.
  server: { proxy: devProxy(loadEnv(mode, 'app', 'REFIT_')) },
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
}));
