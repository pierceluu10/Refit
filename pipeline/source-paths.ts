// Test, spec, story, fixture and example files, by directory or name. Kept apart from the deadline
// scanner so the agent catalog can use it without an import cycle. End-to-end and system test
// directories match only as whole segments with a `test` suffix: a bare `integration/` is app code,
// and so is `playwright/` in tools that drive a browser.
export const TEST_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|specs?|e2e|cypress|fixtures?|examples?|stories|(?:system|integration|acceptance|functional|smoke|e2e)[-_]?tests?|tests?[-_]e2e)\/|\.(?:test|spec|e2e|stories|story)\.[cm]?[jt]sx?$/i;
