// Types for the plain-JavaScript AWS benchmark helpers, so pipeline tests can import them.

export const RUN_ID: RegExp;
export interface ShardSlice {
  shard: number;
  offset: number;
  limit: number;
}
export interface Instance {
  id: string;
  state: string;
  shard: number;
  launched: string;
}
export type ShardState =
  | { shard: number; state: 'finished'; exit: number; stage: string | undefined }
  | { shard: number; state: 'running'; instance: string; launched: string }
  | { shard: number; state: 'lost' };
export interface Launch {
  shard: number;
  instance: string;
  launchedAt: string;
  endedAt?: string;
}
export interface Prices {
  onDemandUsdPerHour: Record<string, number>;
  gp3UsdPerGibMonth: number;
}
export interface CostRow {
  shard: number;
  instance: string;
  hours: number;
  usd: number;
  running?: true;
  estimated?: true;
}
export function bucketName(account: string, region: string): string;
export function shardSlices(total: number, shards: number): ShardSlice[];
export function listSlice<T>(items: T[], offset?: string, limit?: string): T[];
export function fillCommand(template: string, values: ShardSlice & { run: string }): string;
export function bootScript(settings: Record<string, string | number>, template?: string): string;
export function parseExit(text: string): { exit: number; stage: string | undefined };
export function shardStates(
  slices: ShardSlice[],
  exits: Map<number, string>,
  instances: Instance[],
): ShardState[];
export function stateCounts(
  states: ShardState[],
): Record<'succeeded' | 'failed' | 'running' | 'lost', number>;
export function credentialsFailed(stderr: string): boolean;
export function dryRunAllowed(stderr: string): boolean;
export function runCost(
  run: { instanceType: string; market: string; hours: number; diskGib: number },
  launches: Launch[],
  exitTimes: Map<number, string>,
  runningIds: Set<string>,
  now: string,
  prices: Prices,
): { instanceType: string; market: string; launches: CostRow[]; usd: number };
