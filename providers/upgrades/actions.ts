// action_versions: an action's release lines and the Node runtime each one declares. Whether to move
// is the agent's call.

import type { AgentTool } from '../../shared/types.ts';
import {
  compareVersions,
  defineTool,
  fetchPage,
  parseVersion,
  str,
  versionFromTag,
} from '../toolkit/index.ts';
import type { UpgradeToolOptions } from './options.ts';

type Release = { tag_name?: string; published_at?: string; prerelease?: boolean; draft?: boolean };
type Repo = { archived?: boolean; html_url?: string };

export function parseAction(raw: string) {
  const [ref, version] = raw.trim().split('@');
  const [owner, repo, ...path] = ref.split('/');
  return repo ? { owner, repo, path: path.join('/'), version } : undefined;
}

const RUNNERS_URL = 'https://github.com/actions/runner-images';
const ACTIONS_CHANGELOG = 'https://github.blog/changelog/label/actions/';

export function createActionVersionsTool(options: UpgradeToolOptions = {}): AgentTool {
  return defineTool({
    name: 'action_versions',
    description:
      'Look up a GitHub Action: its latest release, the latest release on each major, when each came out, the Node runtime each major declares in action.yml, and whether the repo is archived. Use this to spot deprecated versions, for example a major still on an old Node runtime. Informational.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            'As written in a workflow, e.g. "actions/checkout@v3" or "github/codeql-action/init@v2".',
        },
      },
      required: ['action'],
    },
    run: async (input) => {
      const raw = str(input, 'action');
      const action = raw ? parseAction(raw) : undefined;
      if (!action) {
        return `"${raw ?? ''}" is not an owner/repo action. For a runner label such as ubuntu-22.04, read ${RUNNERS_URL} and ${ACTIONS_CHANGELOG}.`;
      }
      const { owner, repo, path, version } = action;
      const github = `https://github.com/${owner}/${repo}`;
      const api = `https://api.github.com/repos/${owner}/${repo}`;
      const headers = { accept: 'application/vnd.github+json' };
      const [repoPage, releasesPage] = await Promise.all([
        fetchPage(api, { ...options, headers }),
        fetchPage(`${api}/releases?per_page=100`, { ...options, headers }),
      ]);
      const out = [`${owner}/${repo} (${github}):`];
      if (repoPage.ok && (JSON.parse(repoPage.text) as Repo).archived) {
        out.push('The repository is archived: it gets no more releases.');
      }
      const majors = new Map<number, { version: string; date?: string }>();
      if (releasesPage.ok) {
        const releases = (JSON.parse(releasesPage.text) as Release[]).filter(
          (r) => !r.draft && !r.prerelease,
        );
        for (const release of releases) {
          const tag = versionFromTag(release.tag_name ?? '') ?? release.tag_name ?? '';
          const major = parseVersion(tag)?.major;
          if (major === undefined) continue;
          const seen = majors.get(major);
          if (!seen || compareVersions(tag, seen.version) > 0) {
            majors.set(major, { version: tag, date: release.published_at?.slice(0, 10) });
          }
        }
      } else {
        out.push(
          `Could not read the releases (${releasesPage.error}; GitHub limits unauthenticated calls). See ${github}/releases.`,
        );
      }
      // A SHA or branch pin has no major to mark.
      const pinned = /^v?\d+(\.|$)/.test(version ?? '')
        ? parseVersion(version ?? '')?.major
        : undefined;
      const lines = [...majors.keys()].sort((a, b) => b - a).slice(0, 6);
      if (pinned !== undefined && !lines.includes(pinned)) lines.push(pinned);
      const dir = path ? `${path}/` : '';
      const rows = await Promise.all(
        lines.map(async (major) => {
          const release = majors.get(major);
          const ref = `v${major}`;
          let using: string | undefined;
          for (const file of ['action.yml', 'action.yaml']) {
            const page = await fetchPage(
              `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${dir}${file}`,
              options,
            );
            if (!page.ok) continue;
            using = /^\s*using:\s*['"]?([\w.-]+)/m.exec(page.text)?.[1];
            break;
          }
          const mine = major === pinned ? ' <- pinned here' : '';
          return `- v${major}: ${release ? `latest ${release.version}${release.date ? ` (${release.date})` : ''}` : 'no release found'}, runs on ${using ?? 'an unread runtime'}${mine}`;
        }),
      );
      const newest = [...majors.keys()].sort((a, b) => b - a)[0];
      if (newest !== undefined) out.push(`Latest: ${majors.get(newest)?.version}.`);
      out.push('Majors, newest first:', ...rows);
      out.push(
        `A version pinned to a commit SHA should move to a SHA too. Compare each runtime with GitHub's notices at ${ACTIONS_CHANGELOG}; read a major's release notes at ${github}/releases before moving across it.`,
      );
      return out.join('\n');
    },
  });
}
