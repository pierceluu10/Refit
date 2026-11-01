import { folderWatcher } from '../core/registry.ts';

/** Meta Graph API's WatchProvider: the shared watcher agent driven by provider.json and prompt.md. */
export const watch = folderWatcher('meta');
export default watch;
