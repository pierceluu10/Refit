import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeMachine {
  id: string;
  region: string;
  state: string;
  config: {
    image: string;
    env: Record<string, string>;
    guest: Record<string, unknown>;
    metadata: Record<string, string>;
    auto_destroy?: boolean;
    restart?: { policy: string };
  };
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}

// A simulated Fly Machines API on 127.0.0.1 and port 0. It records every call, can answer the next
// requests with queued HTTP failures, and calls onCreate after a machine is created so a test can
// play the machine's part.
export async function fakeFlyMachines(options: {
  app: string;
  token: string;
  onCreate?: (machine: FakeMachine) => void;
}) {
  const machines = new Map<string, FakeMachine>();
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const failures: number[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://fly.local');
      const payload = await body(request);
      calls.push({
        method: request.method ?? '',
        path: `${url.pathname}${url.search}`,
        body: payload,
      });
      const send = (status: number, value?: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(value === undefined ? '' : JSON.stringify(value));
      };
      if (request.headers.authorization !== `Bearer ${options.token}`) return send(401, {});
      const failure = failures.shift();
      if (failure) return send(failure, { error: 'simulated failure' });
      const prefix = `/v1/apps/${options.app}/machines`;
      if (!url.pathname.startsWith(prefix)) return send(404, { error: 'app not found' });
      const id = url.pathname.slice(prefix.length + 1);
      if (request.method === 'POST' && !id) {
        const machine: FakeMachine = {
          id: randomBytes(7).toString('hex'),
          region: payload.region,
          state: 'started',
          config: payload.config,
        };
        machines.set(machine.id, machine);
        send(200, machine);
        setImmediate(() => options.onCreate?.(machine));
        return;
      }
      if (request.method === 'GET' && !id) {
        const filters = [...url.searchParams].filter(([key]) => key.startsWith('metadata.'));
        return send(
          200,
          [...machines.values()].filter(
            (machine) =>
              machine.state !== 'destroyed' &&
              filters.every(([key, value]) => machine.config.metadata[key.slice(9)] === value),
          ),
        );
      }
      const machine = machines.get(id);
      if (!machine || (request.method === 'DELETE' && machine.state === 'destroyed'))
        return send(404, { error: 'machine not found' });
      if (request.method === 'GET') return send(200, machine);
      if (request.method === 'DELETE') {
        if (machine.state === 'started' && url.searchParams.get('force') !== 'true')
          return send(412, { error: 'machine is running' });
        machine.state = 'destroyed';
        return send(200, { ok: true });
      }
      send(405, {});
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    api: `http://127.0.0.1:${port}/v1`,
    machines,
    calls,
    failures,
    // The machine's process exited; auto_destroy removes it.
    exit(id: string) {
      const machine = machines.get(id);
      if (machine) machine.state = 'destroyed';
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
