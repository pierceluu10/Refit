import type { NetworkOptions } from '../toolkit/index.ts';

export type UpgradeToolOptions = NetworkOptions & {
  /** Fixed clock for tests. */
  now?: () => Date;
};

export function today(options: UpgradeToolOptions): string {
  return (options.now?.() ?? new Date()).toISOString().slice(0, 10);
}
