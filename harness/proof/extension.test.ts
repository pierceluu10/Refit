import { describe, expect, it } from 'vitest';
import { browserExtensionCheck, validateManifestV3 } from './extension.ts';
import { fixture } from './test-helpers.ts';

describe('browser extension proof', () => {
  it('lists every MV2 problem and MV2-only API call', async () => {
    const result = await browserExtensionCheck.run({}, { repoDir: fixture('extension-mv2') });
    expect(result.passed).toBe(false);
    const failed = result.failedItems.join('\n');
    for (const problem of [
      'manifest_version is 2, not 3',
      '"browser_action" is MV2',
      'background.persistent is MV2',
      'background.scripts without background.service_worker',
      'host patterns in "permissions" (https://example.com/*)',
      '"webRequestBlocking"',
      'content_security_policy must be an object',
      'web_accessible_resources must be a list',
      'background.js:1 calls chrome.tabs.executeScript; use chrome.scripting.executeScript',
    ])
      expect(failed).toContain(problem);
  });

  it('passes a valid MV3 manifest', async () => {
    const result = await browserExtensionCheck.run({}, { repoDir: fixture('extension-mv3') });
    expect(result.passed).toBe(true);
    expect(result.passedItems).toEqual(['manifest.json is valid Manifest V3']);
  });

  it('checks required fields', () => {
    expect(
      validateManifestV3('m.json', { manifest_version: 3, version: '1.0.0.0.1' }).problems,
    ).toEqual([
      '"name" is required',
      'version "1.0.0.0.1" must be one to four dot-separated integers',
    ]);
  });

  it('is unknown when there is no extension', async () => {
    expect((await browserExtensionCheck.run({}, { repoDir: fixture('web') })).passed).toBe(
      'unknown',
    );
  });
});
