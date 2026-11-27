import { folderWatcher } from '../core/registry.ts';

/** GitHub's WatchProvider: the shared watcher agent driven by provider.json and prompt.md. */
export const watch = folderWatcher('github');
export default watch;
