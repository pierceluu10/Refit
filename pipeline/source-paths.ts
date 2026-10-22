// Test, spec, story, fixture and example files, by directory or name. Kept apart from the deadline
// scanner so the agent catalog can use it without an import cycle.
export const TEST_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|specs?|e2e|cypress|fixtures?|examples?|stories)\/|\.(?:test|spec|e2e|stories|story)\.[cm]?[jt]sx?$/i;
