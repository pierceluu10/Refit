export const packageManagers = {
  npm: { install: 'npm ci', run: 'npm run', test: 'npm test' },
  pnpm: { install: 'pnpm install --frozen-lockfile', run: 'pnpm', test: 'pnpm test' },
  yarn: { install: 'yarn install --immutable', run: 'yarn', test: 'yarn test' },
};

export type PackageManager = keyof typeof packageManagers;
export const validationChecks = ['typecheck', 'lint', 'test'] as const;
export type ValidationCheck = typeof validationChecks[number];
export const MAX_REPAIR_ATTEMPTS = 3;
export const MIN_REPAIR_ATTEMPTS = 1;

export function createConfiguration(manager: PackageManager, checks: readonly ValidationCheck[], attempts: number): string {
  if (!Object.hasOwn(packageManagers, manager)) throw new TypeError('Select a supported package manager.');
  if (!checks.length || checks.some(check => !validationChecks.includes(check))) throw new TypeError('Select at least one supported validation check.');
  if (!Number.isInteger(attempts) || attempts < MIN_REPAIR_ATTEMPTS || attempts > MAX_REPAIR_ATTEMPTS) throw new RangeError(`Repair attempts must be between ${MIN_REPAIR_ATTEMPTS} and ${MAX_REPAIR_ATTEMPTS}.`);
  const commands = packageManagers[manager];
  const selectedChecks = validationChecks.filter(check => checks.includes(check));
  return `version: 1\n\nproviders:\n  - stripe\n\nvalidation:\n  install: ${commands.install}\n  commands:\n${selectedChecks.map(check => `    - ${check === 'test' ? commands.test : `${commands.run} ${check}`}`).join('\n')}\n\nmigration:\n  maxAttempts: ${attempts}\n  draftPullRequests: true\n`;
}
