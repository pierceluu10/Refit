import { folderWatcher } from '../core/registry.ts';

/** OpenAI's WatchProvider: the shared watcher agent driven by provider.json and prompt.md. */
export const watch = folderWatcher('openai');
export default watch;
