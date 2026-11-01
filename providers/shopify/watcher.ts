import { folderWatcher } from '../core/registry.ts';

/** Shopify's WatchProvider: the shared watcher agent driven by provider.json and prompt.md. */
export const watch = folderWatcher('shopify');
export default watch;
