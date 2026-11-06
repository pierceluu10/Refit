import { describe, expect, it } from 'vitest';
import { kubernetesCheck, parseKubeconform, parseManifests, parsePluto } from './kubernetes.ts';
import { fakeSandbox, fixture } from './test-helpers.ts';

describe('kubernetes proof', () => {
  it('parses top-level apiVersion, kind and metadata.name per document', () => {
    const docs = parseManifests(
      'a.yaml',
      'apiVersion: v1\nkind: Service\nmetadata:\n  labels:\n    name: x\n  name: web\n---\napiVersion: apps/v1\nkind: Deployment\n',
    );
    expect(docs).toEqual([
      { file: 'a.yaml', line: 1, apiVersion: 'v1', kind: 'Service', name: 'web' },
      { file: 'a.yaml', line: 8, apiVersion: 'apps/v1', kind: 'Deployment' },
    ]);
  });

  it('finds removed APIs for the target version and says pluto and kubeconform were missing', async () => {
    const sandbox = fakeSandbox(fixture('k8s-old'));
    const result = await kubernetesCheck.run(
      { targetVersion: '1.29' },
      { repoDir: sandbox.dir, sandbox },
    );
    expect(result.passed).toBe(false);
    expect(result.failedItems.join('\n')).toContain(
      'deploy/app.yaml:2 Deployment web uses extensions/v1beta1, removed in 1.16; use apps/v1',
    );
    expect(result.failedItems.join('\n')).toContain(
      'CronJob nightly uses batch/v1beta1, removed in 1.25',
    );
    expect(result.passedItems.join('\n')).toContain('Service web v1 is served in 1.29');
    expect(result.notes.join('\n')).toContain(
      'not installed in the sandbox: pluto, kubeconform, helm',
    );
  });

  it('passes the same manifests for a release before the removal', async () => {
    const sandbox = fakeSandbox(fixture('k8s-old'));
    const result = await kubernetesCheck.run(
      { targetVersion: '1.15' },
      { repoDir: sandbox.dir, sandbox },
    );
    expect(result.passed).toBe(true);
  });

  it('passes migrated manifests', async () => {
    const sandbox = fakeSandbox(fixture('k8s-new'));
    const result = await kubernetesCheck.run(
      { targetVersion: '1.32' },
      { repoDir: sandbox.dir, sandbox },
    );
    expect(result.passed).toBe(true);
    expect(
      result.evidence.some((e) => e.startsWith('passed: app.yaml:1 Deployment web apps/v1')),
    ).toBe(true);
  });

  it('reads Helm templates and notes a target past the built-in table', async () => {
    const sandbox = fakeSandbox(fixture('chart'));
    const result = await kubernetesCheck.run(
      { targetVersion: '1.34' },
      { repoDir: sandbox.dir, sandbox },
    );
    expect(result.failedItems.join('\n')).toContain('templates/hpa.yaml:1 HorizontalPodAutoscaler');
    expect(result.notes.join('\n')).toContain('known through 1.32');
    expect(result.notes.join('\n')).toContain('Helm charts were not rendered');
  });

  it('uses pluto and kubeconform output when the sandbox has them', async () => {
    const pluto = JSON.stringify({
      items: [
        {
          name: 'web',
          filePath: './k.yaml',
          api: {
            version: 'policy/v1beta1',
            kind: 'PodDisruptionBudget',
            'replacement-api': 'policy/v1',
          },
          deprecated: true,
          removed: true,
        },
      ],
    });
    const kubeconform = JSON.stringify({
      resources: [
        {
          filename: 'k.yaml',
          kind: 'Service',
          name: 'x',
          status: 'statusInvalid',
          msg: 'bad port',
        },
      ],
      summary: { valid: 2, invalid: 1, errors: 0 },
    });
    const sandbox = fakeSandbox(fixture('k8s-new'), (command) => {
      if (command.startsWith('command -v'))
        return /helm/.test(command) ? undefined : { code: 0, stdout: '/usr/bin/x' };
      if (command.startsWith('pluto')) return { code: 3, stdout: pluto };
      if (command.startsWith('kubeconform')) return { code: 1, stdout: kubeconform };
      return undefined;
    });
    const result = await kubernetesCheck.run(
      { targetVersion: '1.25' },
      { repoDir: sandbox.dir, sandbox },
    );
    expect(result.passed).toBe(false);
    expect(result.commands).toContain(
      'pluto detect-files -d . -o json --target-versions k8s=v1.25',
    );
    expect(result.failedItems.join('\n')).toContain(
      'pluto: k.yaml PodDisruptionBudget web policy/v1beta1 removed in 1.25; use policy/v1',
    );
    expect(result.failedItems.join('\n')).toContain(
      'kubeconform: 1 invalid, 0 errors of 3 resources',
    );
    expect(result.failedItems.join('\n')).toContain('k.yaml Service x: bad port');
  });

  it('is unknown, not a failure, with no manifests', async () => {
    const sandbox = fakeSandbox(fixture('tls-good'));
    const result = await kubernetesCheck.run({}, { repoDir: sandbox.dir, sandbox });
    expect(result.passed).toBe('unknown');
  });

  it('tolerates junk tool output', () => {
    expect(parsePluto('not json')).toEqual([]);
    expect(parseKubeconform('{}')).toBeUndefined();
  });
});
