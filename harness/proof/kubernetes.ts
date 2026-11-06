// Kubernetes: manifests (and Helm output, when helm is in the sandbox) use no API version the target
// Kubernetes release has removed, and each document still has the fields a manifest needs.
// pluto and kubeconform are used when the sandbox has them; the built-in table is a fallback, not a gate.
import type { Sandbox } from '../types.ts';
import type { ProofCheck, ProofContext } from './types.ts';
import {
  compareVersions,
  execLog,
  hasCommand,
  optString,
  proofDetail,
  readRoot,
  readText,
  shellQuote,
  walkFiles,
  withSandbox,
} from './util.ts';

// Source: https://kubernetes.io/docs/reference/using-api/deprecation-guide/ (removals through 1.32).
// `removedIn` is the first release that no longer serves the version; `use` is its replacement.
export const REMOVED_K8S_APIS: {
  apiVersion: string;
  kinds: string[];
  removedIn: string;
  use: string;
}[] = [
  {
    apiVersion: 'extensions/v1beta1',
    kinds: ['Deployment', 'DaemonSet', 'ReplicaSet'],
    removedIn: '1.16',
    use: 'apps/v1',
  },
  {
    apiVersion: 'extensions/v1beta1',
    kinds: ['NetworkPolicy'],
    removedIn: '1.16',
    use: 'networking.k8s.io/v1',
  },
  {
    apiVersion: 'extensions/v1beta1',
    kinds: ['PodSecurityPolicy'],
    removedIn: '1.16',
    use: 'policy/v1beta1 (itself removed in 1.25)',
  },
  {
    apiVersion: 'apps/v1beta1',
    kinds: ['Deployment', 'StatefulSet', 'ReplicaSet'],
    removedIn: '1.16',
    use: 'apps/v1',
  },
  {
    apiVersion: 'apps/v1beta2',
    kinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'],
    removedIn: '1.16',
    use: 'apps/v1',
  },
  {
    apiVersion: 'extensions/v1beta1',
    kinds: ['Ingress'],
    removedIn: '1.22',
    use: 'networking.k8s.io/v1',
  },
  {
    apiVersion: 'networking.k8s.io/v1beta1',
    kinds: ['Ingress', 'IngressClass'],
    removedIn: '1.22',
    use: 'networking.k8s.io/v1',
  },
  {
    apiVersion: 'admissionregistration.k8s.io/v1beta1',
    kinds: ['MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration'],
    removedIn: '1.22',
    use: 'admissionregistration.k8s.io/v1',
  },
  {
    apiVersion: 'apiextensions.k8s.io/v1beta1',
    kinds: ['CustomResourceDefinition'],
    removedIn: '1.22',
    use: 'apiextensions.k8s.io/v1',
  },
  {
    apiVersion: 'apiregistration.k8s.io/v1beta1',
    kinds: ['APIService'],
    removedIn: '1.22',
    use: 'apiregistration.k8s.io/v1',
  },
  {
    apiVersion: 'authentication.k8s.io/v1beta1',
    kinds: ['TokenReview'],
    removedIn: '1.22',
    use: 'authentication.k8s.io/v1',
  },
  {
    apiVersion: 'authorization.k8s.io/v1beta1',
    kinds: ['SubjectAccessReview', 'LocalSubjectAccessReview', 'SelfSubjectAccessReview'],
    removedIn: '1.22',
    use: 'authorization.k8s.io/v1',
  },
  {
    apiVersion: 'certificates.k8s.io/v1beta1',
    kinds: ['CertificateSigningRequest'],
    removedIn: '1.22',
    use: 'certificates.k8s.io/v1',
  },
  {
    apiVersion: 'coordination.k8s.io/v1beta1',
    kinds: ['Lease'],
    removedIn: '1.22',
    use: 'coordination.k8s.io/v1',
  },
  {
    apiVersion: 'rbac.authorization.k8s.io/v1beta1',
    kinds: ['ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding'],
    removedIn: '1.22',
    use: 'rbac.authorization.k8s.io/v1',
  },
  {
    apiVersion: 'scheduling.k8s.io/v1beta1',
    kinds: ['PriorityClass'],
    removedIn: '1.22',
    use: 'scheduling.k8s.io/v1',
  },
  {
    apiVersion: 'storage.k8s.io/v1beta1',
    kinds: ['CSIDriver', 'CSINode', 'StorageClass', 'VolumeAttachment'],
    removedIn: '1.22',
    use: 'storage.k8s.io/v1',
  },
  { apiVersion: 'batch/v1beta1', kinds: ['CronJob'], removedIn: '1.25', use: 'batch/v1' },
  {
    apiVersion: 'discovery.k8s.io/v1beta1',
    kinds: ['EndpointSlice'],
    removedIn: '1.25',
    use: 'discovery.k8s.io/v1',
  },
  {
    apiVersion: 'events.k8s.io/v1beta1',
    kinds: ['Event'],
    removedIn: '1.25',
    use: 'events.k8s.io/v1',
  },
  {
    apiVersion: 'autoscaling/v2beta1',
    kinds: ['HorizontalPodAutoscaler'],
    removedIn: '1.25',
    use: 'autoscaling/v2',
  },
  {
    apiVersion: 'policy/v1beta1',
    kinds: ['PodDisruptionBudget'],
    removedIn: '1.25',
    use: 'policy/v1',
  },
  {
    apiVersion: 'policy/v1beta1',
    kinds: ['PodSecurityPolicy'],
    removedIn: '1.25',
    use: 'Pod Security Admission (no replacement API)',
  },
  {
    apiVersion: 'node.k8s.io/v1beta1',
    kinds: ['RuntimeClass'],
    removedIn: '1.25',
    use: 'node.k8s.io/v1',
  },
  {
    apiVersion: 'flowcontrol.apiserver.k8s.io/v1beta1',
    kinds: ['FlowSchema', 'PriorityLevelConfiguration'],
    removedIn: '1.26',
    use: 'flowcontrol.apiserver.k8s.io/v1',
  },
  {
    apiVersion: 'autoscaling/v2beta2',
    kinds: ['HorizontalPodAutoscaler'],
    removedIn: '1.26',
    use: 'autoscaling/v2',
  },
  {
    apiVersion: 'storage.k8s.io/v1beta1',
    kinds: ['CSIStorageCapacity'],
    removedIn: '1.27',
    use: 'storage.k8s.io/v1',
  },
  {
    apiVersion: 'flowcontrol.apiserver.k8s.io/v1beta2',
    kinds: ['FlowSchema', 'PriorityLevelConfiguration'],
    removedIn: '1.29',
    use: 'flowcontrol.apiserver.k8s.io/v1',
  },
  {
    apiVersion: 'flowcontrol.apiserver.k8s.io/v1beta3',
    kinds: ['FlowSchema', 'PriorityLevelConfiguration'],
    removedIn: '1.32',
    use: 'flowcontrol.apiserver.k8s.io/v1',
  },
];
const TABLE_KNOWN_THROUGH = '1.32';

export type K8sDocument = {
  file: string;
  line: number;
  apiVersion?: string;
  kind?: string;
  name?: string;
};

// Line-based: top-level `apiVersion:`, `kind:` and `metadata.name` per `---` document. Good enough for
// manifests and most Helm templates; the agent reads anything stranger itself.
export function parseManifests(file: string, text: string): K8sDocument[] {
  const docs: K8sDocument[] = [];
  let current: K8sDocument | undefined;
  let inMetadata = false;
  let metaIndent: string | undefined;
  const lines = text.split('\n');
  const flush = () => {
    if (current && (current.apiVersion || current.kind)) docs.push(current);
  };
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^---/.test(line) || i === 0) {
      if (i !== 0) flush();
      current = { file, line: i + 1 };
      inMetadata = false;
      if (/^---/.test(line)) return;
    }
    const top = /^(apiVersion|kind|metadata):\s*(.*)$/.exec(line);
    if (top && current) {
      const value = top[2].trim().replace(/^["']|["']$/g, '');
      if (top[1] === 'apiVersion') {
        current.apiVersion = value;
        current.line = i + 1;
      }
      if (top[1] === 'kind') current.kind = value;
      inMetadata = top[1] === 'metadata';
      metaIndent = undefined;
      return;
    }
    if (inMetadata && current && line.trim()) {
      const child = /^(\s+)(\S[^:]*):\s*(.*)$/.exec(line);
      if (!child) {
        if (/^\S/.test(line)) inMetadata = false;
        return;
      }
      metaIndent ??= child[1];
      if (child[1] === metaIndent && child[2] === 'name' && !current.name)
        current.name = child[3].trim().replace(/^["']|["']$/g, '');
    }
  });
  flush();
  return docs;
}

export function removedApiFor(doc: K8sDocument, target: string) {
  return REMOVED_K8S_APIS.find(
    (entry) =>
      entry.apiVersion === doc.apiVersion &&
      !!doc.kind &&
      entry.kinds.includes(doc.kind) &&
      compareVersions(target, entry.removedIn) >= 0,
  );
}

const LIST_KINDS = /List$|^Kustomization$|^Component$/;

async function findManifests(root: string): Promise<{ docs: K8sDocument[]; charts: string[] }> {
  const files = await walkFiles(root);
  const docs: K8sDocument[] = [];
  const charts: string[] = [];
  for (const file of files) {
    if (/(^|\/)Chart\.ya?ml$/.test(file)) charts.push(file.replace(/\/?Chart\.ya?ml$/, '') || '.');
    if (!/\.ya?ml$/.test(file)) continue;
    const text = await readText(root, file);
    if (!text || !/^apiVersion:/m.test(text) || !/^kind:/m.test(text)) continue;
    docs.push(...parseManifests(file, text));
  }
  return { docs, charts };
}

export const kubernetesCheck: ProofCheck = {
  name: 'kubernetes',
  description:
    'Check Kubernetes manifests and Helm output for API versions removed in the target Kubernetes release, and that each document still validates. Uses pluto, kubeconform and helm in the sandbox when they are installed; otherwise a built-in table of removed APIs (through 1.32) and a structural check. Returns evidence, never blocks.',
  inputSchema: {
    type: 'object',
    properties: {
      targetVersion: {
        type: 'string',
        description:
          'Target Kubernetes version, e.g. "1.32". Default: newest in the built-in table',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only these files or folders (relative). Default: the whole repo',
      },
    },
  },
  run: async (input, ctx) => {
    const target = (optString(input, 'targetVersion') ?? TABLE_KNOWN_THROUGH).replace(/^v/, '');
    const root = readRoot(ctx);
    const only = Array.isArray(input.paths)
      ? (input.paths as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];
    const found = await findManifests(root);
    const inScope = (file: string) =>
      only.length === 0 ||
      only.some((p) => file === p || file.startsWith(`${p.replace(/\/$/, '')}/`));
    const docs = found.docs.filter((doc) => inScope(doc.file));
    const charts = found.charts.filter((chart) =>
      inScope(chart === '.' ? 'Chart.yaml' : `${chart}/Chart.yaml`),
    );

    const passedItems: string[] = [];
    const failedItems: string[] = [];
    const notes: string[] = [];
    if (compareVersions(target, TABLE_KNOWN_THROUGH) > 0)
      notes.push(
        `built-in removal table is known through ${TABLE_KNOWN_THROUGH}; check removals after it at the deprecation guide or with pluto`,
      );

    for (const doc of docs) {
      const where = `${doc.file}:${doc.line} ${doc.kind ?? '?'}${doc.name ? ` ${doc.name}` : ''}`;
      const removed = removedApiFor(doc, target);
      if (removed)
        failedItems.push(
          `${where} uses ${doc.apiVersion}, removed in ${removed.removedIn}; use ${removed.use}`,
        );
      const missing = [
        !doc.apiVersion && 'apiVersion',
        !doc.kind && 'kind',
        !doc.name &&
          !LIST_KINDS.test(doc.kind ?? '') &&
          !doc.file.includes('templates/') &&
          'metadata.name',
      ].filter(Boolean);
      if (missing.length) failedItems.push(`${where} is missing ${missing.join(', ')}`);
      if (!removed && !missing.length)
        passedItems.push(`${where} ${doc.apiVersion} is served in ${target}`);
    }

    // Templates are not valid YAML until helm renders them, so kubeconform gets the rendered output.
    const manifestFiles = [...new Set(docs.map((d) => d.file))].filter(
      (f) => !/(^|\/)templates\//.test(f),
    );
    const sandboxed = await sandboxTools(ctx, target, charts, inScope, manifestFiles);
    return proofDetail('kubernetes', {
      commands: sandboxed.commands,
      passedItems: [...passedItems, ...sandboxed.passedItems],
      failedItems: [...failedItems, ...sandboxed.failedItems],
      notes: [
        `${docs.length} Kubernetes documents in ${new Set(docs.map((d) => d.file)).size} files; ${charts.length} Helm charts`,
        ...notes,
        ...sandboxed.notes,
      ],
      logTail: sandboxed.logTail,
      ...(docs.length === 0 && charts.length === 0 ? { passed: 'unknown' as const } : {}),
    });
  },
};

// pluto, kubeconform and helm run in the sandbox: rendering a chart and validating it reads only repo
// files, but chart plugins and schemas come from the repo, so it stays inside like everything else.
async function sandboxTools(
  ctx: ProofContext,
  target: string,
  charts: string[],
  inScope: (file: string) => boolean,
  manifestFiles: string[],
) {
  const commands: string[] = [];
  const passedItems: string[] = [];
  const failedItems: string[] = [];
  const notes: string[] = [];
  let logTail: string | undefined;
  const missing: string[] = [];
  try {
    await withSandbox(ctx, async (sandbox: Sandbox) => {
      const has = {
        pluto: await hasCommand(sandbox, 'pluto'),
        kubeconform: await hasCommand(sandbox, 'kubeconform'),
        helm: await hasCommand(sandbox, 'helm'),
      };
      for (const [tool, present] of Object.entries(has)) if (!present) missing.push(tool);
      const rendered: string[] = [];
      if (has.helm) {
        for (const chart of charts) {
          const out = `/tmp/refit-helm-${rendered.length}.yaml`;
          const command = `helm template refit-proof ${shellQuote(chart)} > ${out}`;
          commands.push(command);
          const result = await sandbox.exec(command, { timeoutMs: 120_000 });
          if (result.code === 0) {
            passedItems.push(`helm template ${chart} rendered`);
            rendered.push(out);
          } else {
            failedItems.push(`helm template ${chart} failed (exit ${result.code})`);
            logTail = execLog(result);
          }
        }
      }
      if (has.pluto) {
        const command = `pluto detect-files -d . -o json --target-versions k8s=v${target}`;
        commands.push(command);
        const result = await sandbox.exec(command, { timeoutMs: 120_000 });
        const items = parsePluto(result.stdout).filter((item) => inScope(item.file));
        for (const item of items) {
          const label = `pluto: ${item.file} ${item.kind} ${item.name} ${item.apiVersion}`;
          if (item.removed)
            failedItems.push(
              `${label} removed in ${target}${item.replacement ? `; use ${item.replacement}` : ''}`,
            );
          else if (item.deprecated)
            notes.push(
              `${label} deprecated in ${target}${item.replacement ? `; use ${item.replacement}` : ''}`,
            );
        }
        if (result.code !== 0 && items.length === 0 && !result.stdout.trim())
          logTail = execLog(result);
        else if (!items.some((i) => i.removed))
          passedItems.push(`pluto found no removed APIs for ${target}`);
        for (const out of rendered) {
          const helmCommand = `pluto detect ${out} -o json --target-versions k8s=v${target}`;
          commands.push(helmCommand);
          const helmResult = await sandbox.exec(helmCommand, { timeoutMs: 120_000 });
          for (const item of parsePluto(helmResult.stdout).filter((i) => i.removed))
            failedItems.push(
              `pluto (helm output): ${item.kind} ${item.name} ${item.apiVersion} removed in ${target}`,
            );
        }
      }
      if (has.kubeconform && manifestFiles.length + rendered.length > 0) {
        const targets = [...manifestFiles, ...rendered].map(shellQuote).join(' ');
        const command = `kubeconform -summary -output json -ignore-missing-schemas -kubernetes-version ${target}.0 ${targets}`;
        commands.push(command);
        const result = await sandbox.exec(command, { timeoutMs: 300_000 });
        const summary = parseKubeconform(result.stdout);
        if (summary) {
          if (summary.invalid + summary.errors > 0)
            failedItems.push(
              `kubeconform: ${summary.invalid} invalid, ${summary.errors} errors of ${summary.valid + summary.invalid + summary.errors} resources`,
            );
          else passedItems.push(`kubeconform: ${summary.valid} resources valid against ${target}`);
          for (const message of summary.messages.slice(0, 10))
            failedItems.push(`kubeconform: ${message}`);
        } else {
          notes.push(
            `kubeconform gave no summary (exit ${result.code}); schemas may need network access`,
          );
          logTail = execLog(result);
        }
      }
    });
  } catch (error) {
    notes.push(
      `sandbox unavailable, so pluto, kubeconform and helm were not run: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { commands, passedItems, failedItems, notes, logTail };
  }
  if (missing.length)
    notes.push(
      `not installed in the sandbox: ${missing.join(', ')}; used the built-in removed-API table${missing.includes('helm') && charts.length ? ', and Helm charts were not rendered' : ''}`,
    );
  return { commands, passedItems, failedItems, notes, logTail };
}

type PlutoItem = {
  file: string;
  kind: string;
  name: string;
  apiVersion: string;
  deprecated: boolean;
  removed: boolean;
  replacement?: string;
};

export function parsePluto(stdout: string): PlutoItem[] {
  try {
    const parsed = JSON.parse(stdout) as { items?: Record<string, unknown>[] };
    return (parsed.items ?? []).map((item) => {
      const api = (item.api ?? {}) as Record<string, unknown>;
      return {
        file: String(item.filePath ?? '').replace(/^\.\//, ''),
        kind: String(api.kind ?? ''),
        name: String(item.name ?? ''),
        apiVersion: String(api.version ?? ''),
        deprecated: item.deprecated === true,
        removed: item.removed === true,
        replacement:
          typeof api['replacement-api'] === 'string'
            ? (api['replacement-api'] as string)
            : undefined,
      };
    });
  } catch {
    return [];
  }
}

export function parseKubeconform(stdout: string) {
  try {
    const parsed = JSON.parse(stdout) as {
      resources?: {
        filename?: string;
        kind?: string;
        name?: string;
        status?: string;
        msg?: string;
      }[];
      summary?: { valid?: number; invalid?: number; errors?: number };
    };
    if (!parsed.summary) return undefined;
    return {
      valid: parsed.summary.valid ?? 0,
      invalid: parsed.summary.invalid ?? 0,
      errors: parsed.summary.errors ?? 0,
      messages: (parsed.resources ?? [])
        .filter((r) => r.status === 'statusInvalid' || r.status === 'statusError')
        .map((r) =>
          `${r.filename ?? '?'} ${r.kind ?? ''} ${r.name ?? ''}: ${r.msg ?? r.status}`.trim(),
        ),
    };
  } catch {
    return undefined;
  }
}
