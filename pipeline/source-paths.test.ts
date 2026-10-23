import { expect, test } from 'vitest';
import { GO_TEST_PATH } from './go/calls.ts';
import { PYTHON_TEST_PATH } from './python/models.ts';
import { TEST_PATH } from './source-paths.ts';

const testDirectories = [
  'system_test/prompts_e2e_test.ts',
  'vertexai/system_tests/run.ts',
  'packages/integration-tests/src/messenger-utils.ts',
  'integration_test/chat.ts',
  'dotnet/src/IntegrationTests/client.ts',
  'acceptance_tests/chat.ts',
  'functional-test/chat.ts',
  'smoke_tests/chat.ts',
  'e2e-tests/chat.ts',
  'tests-e2e/chat.ts',
  'test_e2e/chat.ts',
];
// App code whose names only contain these words.
const appPaths = [
  'src/systemtest.ts',
  'src/integrations/shopify.ts',
  'packages/gin/integration/asker.ts',
  'lib/e2e-encryption/keys.ts',
  'adapters-e2e/scenarios/audioTranscribe.ts',
  'src/smoke.ts',
  'src-functional/bot-loop.ts',
  'scripts/smoke-npm-mcp.mjs',
  'app/actions/integration-actions.ts',
  'internal/ai/test_failure.go',
  'src/targets/playwright/run.ts',
  'src/plugins/playwright/index.ts',
];

test('TEST_PATH treats end-to-end and system test directories as tests, by whole segment', () => {
  for (const path of [...testDirectories, 'cypress/support/chat.ts'])
    expect(TEST_PATH.test(path), path).toBe(true);
  for (const path of appPaths) expect(TEST_PATH.test(path), path).toBe(false);
});

test('the Go and Python tracers use the same test directories', () => {
  for (const pattern of [GO_TEST_PATH, PYTHON_TEST_PATH]) {
    for (const path of testDirectories) expect(pattern.test(path), path).toBe(true);
    for (const path of appPaths) expect(pattern.test(path), path).toBe(false);
  }
  expect(GO_TEST_PATH.test('cmd/chat_test.go')).toBe(true);
  expect(GO_TEST_PATH.test('cmd/attest.go')).toBe(false);
  for (const path of ['src/test_chat.py', 'src/chat_test.py', 'conftest.py'])
    expect(PYTHON_TEST_PATH.test(path), path).toBe(true);
  for (const path of ['src/latest.py', 'src/contest.py'])
    expect(PYTHON_TEST_PATH.test(path), path).toBe(false);
});
