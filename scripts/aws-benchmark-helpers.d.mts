// Types for the plain-JavaScript AWS benchmark helpers, so pipeline tests can import them.

export const RUN_ID: RegExp;
export interface ShardSlice {
  shard: number;
  offset: number;
  limit: number;
}
export function bucketName(account: string, region: string): string;
export function shardSlices(total: number, shards: number): ShardSlice[];
export function fillCommand(template: string, values: ShardSlice & { run: string }): string;
export function bootScript(settings: Record<string, string | number>, template?: string): string;
