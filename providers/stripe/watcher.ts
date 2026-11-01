import { folderWatcher } from '../core/registry.ts';

/** Stripe's WatchProvider: the shared watcher agent driven by provider.json and prompt.md. */
export const watch = folderWatcher('stripe');
export default watch;
