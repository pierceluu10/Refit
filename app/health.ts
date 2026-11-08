import { join } from 'node:path';
import { dockerAvailable } from '../harness/sandbox.ts';
import { writeJsonAtomic } from './queue.ts';

const PROBE_FILE = '.health-probe.json';
// /healthz is public and each check writes a file and starts `docker info`, so a burst shares one.
const CHECK_INTERVAL_MS = 10_000;

export type Health = { ok: boolean; store: boolean; sandbox: boolean };
export type CheckHealth = () => Promise<Health>;

export type HealthDeps = {
  stateDir: string;
  // Only a host pinned to the Docker sandbox needs its daemon; a laptop without Docker still serves.
  sandboxRequired: boolean;
  sandboxReady?: () => Promise<boolean>;
  now?: () => number;
};

async function storeWritable(stateDir: string): Promise<boolean> {
  try {
    await writeJsonAtomic(join(stateDir, PROBE_FILE), { checkedAt: new Date().toISOString() });
    return true;
  } catch (error) {
    console.error(`health: the state store is not writable: ${(error as Error).message}`);
    return false;
  }
}

export function createHealthCheck({
  stateDir,
  sandboxRequired,
  sandboxReady = dockerAvailable,
  now = Date.now,
}: HealthDeps): CheckHealth {
  let last: { at: number; result: Promise<Health> } | undefined;
  const check = async (): Promise<Health> => {
    const [store, sandbox] = await Promise.all([
      storeWritable(stateDir),
      sandboxRequired ? sandboxReady() : true,
    ]);
    return { ok: store && sandbox, store, sandbox };
  };
  return () => {
    if (!last || now() - last.at >= CHECK_INTERVAL_MS) last = { at: now(), result: check() };
    return last.result;
  };
}
