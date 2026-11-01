import { folderWatcher } from '../core/registry.ts';

/** Twilio's WatchProvider: the shared watcher agent driven by provider.json and prompt.md. */
export const watch = folderWatcher('twilio');
export default watch;
