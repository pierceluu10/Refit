import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devProxy } from '../vite.config';

const SOURCE_DIR = 'src';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

describe('dev proxy', () => {
  it('attaches the service token on the server side', () => {
    const { '/api': proxy } = devProxy({ REFIT_SERVICE_TOKEN: 'test-token' });
    expect(proxy.headers).toEqual({ authorization: 'Bearer test-token' });
    expect(proxy.target).toBe('http://127.0.0.1:3000');
  });

  it('forwards without a header when no token is set, so the API answers 401', () => {
    expect(devProxy({})['/api'].headers).toBeUndefined();
  });

  it('honours REFIT_APP_URL', () => {
    expect(devProxy({ REFIT_APP_URL: 'http://127.0.0.1:4100' })['/api'].target).toBe(
      'http://127.0.0.1:4100',
    );
  });

  it('never names the service token in browser code', () => {
    const offenders = sourceFiles(SOURCE_DIR).filter(
      (file) =>
        !file.endsWith('devProxy.test.ts') &&
        /REFIT_SERVICE_TOKEN|VITE_[A-Z_]*TOKEN/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
