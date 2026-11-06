// docker_image_tags: which tags an image's maintainers still support. Official images publish that
// list in docker-library/docs; for the rest, Docker Hub's recent tags are the closest evidence.

import type { AgentTool } from '../../shared/types.ts';
import { defineTool, fetchPage, str } from '../toolkit/index.ts';
import type { UpgradeToolOptions } from './options.ts';

type HubTag = {
  name?: string;
  last_updated?: string;
  tag_last_pushed?: string;
  tag_status?: string;
};

export function parseImage(raw: string) {
  const [ref] = raw.trim().split('@');
  const parts = ref.split('/');
  const registry =
    parts.length > 1 && /[.:]|^localhost$/.test(parts[0]) ? parts.shift() : undefined;
  const [name, tag] = parts.join('/').split(':');
  return { registry, repository: name.includes('/') ? name : `library/${name}`, tag };
}

/** Each bullet in an official image's "Supported tags" section, as its list of tags. */
export function supportedTags(readme: string): string[][] {
  const start = readme.indexOf('# Supported tags');
  if (start < 0) return [];
  const end = readme.indexOf('\n# ', start + 1);
  return readme
    .slice(start, end < 0 ? undefined : end)
    .split('\n')
    .filter((line) => line.startsWith('-'))
    .map((line) => [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]))
    .filter((tags) => tags.length > 0);
}

export function createDockerImageTagsTool(options: UpgradeToolOptions = {}): AgentTool {
  return defineTool({
    name: 'docker_image_tags',
    description:
      "List the supported tags of a base image from Docker Hub, and say whether the tag in use is still supported and when it was last rebuilt. A tag that still exists can be long past its last rebuild. Informational; end_of_life gives the runtime's own dates.",
    inputSchema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: 'As written after FROM, e.g. "node:18-bookworm" or "bitnami/redis:7.2".',
        },
      },
      required: ['image'],
    },
    run: async (input) => {
      const raw = str(input, 'image');
      if (!raw) return 'Pass "image", e.g. "node:18-bookworm".';
      const { registry, repository, tag } = parseImage(raw);
      if (registry && registry !== 'docker.io') {
        return `${raw} is on ${registry}; this tool reads Docker Hub only. Check that registry's tag list and the image's own docs.`;
      }
      const hub = `https://hub.docker.com/v2/repositories/${repository}`;
      const official = repository.startsWith('library/');
      const short = repository.replace('library/', '');
      const out = [
        `${official ? short : repository} (https://hub.docker.com/${official ? `_/${short}` : `r/${repository}`}):`,
      ];
      if (tag) {
        const page = await fetchPage(`${hub}/tags/${encodeURIComponent(tag)}`, options);
        if (page.ok) {
          const info = JSON.parse(page.text) as HubTag;
          out.push(
            `Tag ${tag}: last pushed ${(info.tag_last_pushed ?? info.last_updated ?? 'unknown').slice(0, 10)}, status ${info.tag_status ?? 'unknown'}.`,
          );
        } else {
          out.push(`Tag ${tag}: not read from Docker Hub (${page.error}).`);
        }
      }
      if (official) {
        const url = `https://raw.githubusercontent.com/docker-library/docs/master/${short}/README.md`;
        const page = await fetchPage(url, options);
        const groups = page.ok ? supportedTags(page.text) : [];
        if (groups.length) {
          if (tag) {
            out.push(
              groups.some((g) => g.includes(tag))
                ? `${tag} is on the supported list.`
                : `${tag} is not on the maintainers' supported list.`,
            );
          }
          out.push(
            `Supported tags (${url}), one line per image:`,
            ...groups.slice(0, 40).map((g) => `- ${g.slice(0, 6).join(', ')}`),
          );
          if (groups.length > 40) out.push(`[${groups.length - 40} more lines at that link]`);
          return out.join('\n');
        }
        out.push(`No supported-tags list read from ${url}${page.ok ? '' : ` (${page.error})`}.`);
      }
      const page = await fetchPage(`${hub}/tags?page_size=100&ordering=last_updated`, options);
      if (!page.ok) {
        out.push(`Could not list tags (${page.error}).`);
        return out.join('\n');
      }
      const results = (JSON.parse(page.text) as { results?: HubTag[] }).results ?? [];
      // Signing and attestation artifacts show up as tags on Docker Hub.
      const tags = results.filter(
        (t) => !/^sha256-|\.(?:sig|att|metadata)$|-metadata$/.test(t.name ?? ''),
      );
      out.push(
        tags.length
          ? 'No official supported list. Most recently pushed tags:'
          : `No official supported list, and the ${results.length} most recently pushed tags are all signing artifacts. See the image's page.`,
        ...tags.map(
          (t) => `- ${t.name} (${(t.tag_last_pushed ?? t.last_updated ?? 'unknown').slice(0, 10)})`,
        ),
      );
      return out.join('\n');
    },
  });
}
