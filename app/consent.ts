import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from './json-file.ts';

const FILE_EXISTS = 'EEXIST';

export class InvalidInstallationError extends Error {
  constructor(installationId: unknown) {
    super(`Not a GitHub installation id: ${JSON.stringify(installationId)}`);
    this.name = 'InvalidInstallationError';
  }
}

type Setting = { shareLearning: boolean; updatedAt: string };

export type ConsentStore = {
  // Writes the default, no, unless the installation already has an answer: a redelivered install
  // must never undo a customer's yes.
  recordInstall: (installationId: number) => Promise<void>;
  set: (installationId: number, shareLearning: boolean) => Promise<void>;
  // An uninstall drops the answer, so installing again starts from no.
  forget: (installationId: number) => Promise<void>;
  // True only for a stored, readable yes.
  consented: (installationId: number) => Promise<boolean>;
};

// One file per installation, so the CLI and the server never overwrite each other's installations.
export function createConsentStore(dir: string, now = () => new Date()): ConsentStore {
  const fileFor = (installationId: number) => {
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new InvalidInstallationError(installationId);
    }
    return join(dir, `${installationId}.json`);
  };
  const setting = (shareLearning: boolean): Setting => ({
    shareLearning,
    updatedAt: now().toISOString(),
  });

  return {
    async recordInstall(installationId) {
      const file = fileFor(installationId);
      await mkdir(dir, { recursive: true });
      try {
        await writeFile(file, JSON.stringify(setting(false)), { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== FILE_EXISTS) throw error;
      }
    },
    set: async (installationId, shareLearning) =>
      writeJsonFile(fileFor(installationId), setting(shareLearning)),
    forget: async (installationId) => rm(fileFor(installationId), { force: true }),
    async consented(installationId) {
      // Any failure here means no: a broken disk or file must never share a customer's learning.
      try {
        const stored = await readJsonFile<Setting>(fileFor(installationId));
        return stored?.shareLearning === true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`consent for installation ${installationId} unreadable: ${message}`);
        return false;
      }
    },
  };
}
