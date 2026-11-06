// end_of_life: support dates from endoflife.date. The "recommended target" is a hint from those
// dates; the agent picks the target.

import type { AgentTool } from '../../shared/types.ts';
import { closest, defineTool, fetchPage, str } from '../toolkit/index.ts';
import { today, type UpgradeToolOptions } from './options.ts';

type Cycle = {
  cycle: string;
  codename?: string;
  releaseDate?: string;
  eol?: string | boolean;
  support?: string | boolean;
  lts?: string | boolean;
  latest?: string;
  link?: string | null;
};

// Names repos and images use where endoflife.date's slug differs. A miss still gets suggestions.
const SLUGS: Record<string, string> = {
  node: 'nodejs',
  'node.js': 'nodejs',
  next: 'nextjs',
  'next.js': 'nextjs',
  python3: 'python',
  cpython: 'python',
  postgres: 'postgresql',
  mongo: 'mongodb',
  golang: 'go',
  k8s: 'kubernetes',
  '.net': 'dotnet',
};

function isPast(date: string | boolean | undefined, now: string): boolean {
  return typeof date === 'string' ? date <= now : date === true;
}

/** The cycle a version belongs to: the longest cycle that prefixes it, or its codename. */
export function cycleFor(version: string, cycles: Cycle[]): Cycle | undefined {
  const raw = version.trim().toLowerCase();
  const numeric = /\d+(?:\.\d+)*/.exec(raw)?.[0];
  return (
    cycles.find((c) => c.cycle === raw || c.codename?.toLowerCase() === raw) ??
    (numeric
      ? cycles
          .filter((c) => numeric === c.cycle || numeric.startsWith(`${c.cycle}.`))
          .sort((a, b) => b.cycle.length - a.cycle.length)[0]
      : undefined)
  );
}

function describe(cycle: Cycle, now: string): string {
  const eol =
    typeof cycle.eol === 'string'
      ? `${isPast(cycle.eol, now) ? 'ended' : 'ends'} ${cycle.eol}`
      : cycle.eol
        ? 'ended (no date listed)'
        : 'no end date listed';
  const parts = [`${cycle.cycle}${cycle.codename ? ` (${cycle.codename})` : ''}: support ${eol}`];
  if (typeof cycle.support === 'string') parts.push(`active support to ${cycle.support}`);
  if (isPast(cycle.lts, now)) parts.push('LTS');
  if (cycle.latest) parts.push(`latest ${cycle.latest}`);
  return parts.join(', ');
}

export function createEndOfLifeTool(options: UpgradeToolOptions = {}): AgentTool {
  return defineTool({
    name: 'end_of_life',
    description:
      "Look up a runtime, framework, OS or database on endoflife.date: when a version's support ends, which versions are still supported, and a recommended target (the newest supported LTS, or the newest supported version). Informational; choose the target yourself.",
    inputSchema: {
      type: 'object',
      properties: {
        product: {
          type: 'string',
          description: 'E.g. "node", "python", "django", "nextjs", "debian".',
        },
        version: {
          type: 'string',
          description: 'The version in use, e.g. "18", "3.9.7", ">=3.9", "bookworm".',
        },
      },
      required: ['product'],
    },
    run: async (input) => {
      const raw = str(input, 'product')?.toLowerCase();
      if (!raw) return 'Pass "product", e.g. "node" or "python".';
      // An image reference like "node:18-bookworm" carries both.
      const [name, tag] = raw.split(':');
      const slug = SLUGS[name] ?? name;
      const version = str(input, 'version') ?? tag;
      const url = `https://endoflife.date/api/${encodeURIComponent(slug)}.json`;
      const page = await fetchPage(url, options);
      if (!page.ok) {
        const all = await fetchPage('https://endoflife.date/api/all.json', options);
        const known = all.ok ? (JSON.parse(all.text) as string[]) : [];
        const near = [
          ...new Set([...known.filter((k) => k.includes(slug)), ...closest(slug, known)]),
        ];
        return [
          `endoflife.date has no answer for "${slug}" (${page.error}).`,
          near.length ? `Similar products: ${near.slice(0, 8).join(', ')}.` : '',
          "Check the project's own release or support page instead.",
        ]
          .filter(Boolean)
          .join('\n');
      }
      const now = today(options);
      const cycles = JSON.parse(page.text) as Cycle[];
      const released = cycles.filter((c) => !c.releaseDate || c.releaseDate <= now);
      const supported = released.filter((c) => !isPast(c.eol, now));
      const lts = supported.filter((c) => isPast(c.lts, now));
      const target = lts[0] ?? supported[0];
      const out = [`${slug}, as of ${now} (https://endoflife.date/${slug}, data: ${url}):`];
      if (version) {
        const current = cycleFor(version, cycles);
        out.push(
          current
            ? `Your version ${version} is in ${describe(current, now)}.${isPast(current.eol, now) ? ' It is past end of life.' : ''}${current.link ? ` Release notes: ${current.link}` : ''}`
            : `No release cycle matches "${version}". Listed cycles: ${cycles
                .slice(0, 12)
                .map((c) => c.cycle)
                .join(', ')}.`,
        );
      }
      out.push(
        target
          ? `Recommended target: ${describe(target, now)}.${supported[0] !== target ? ` Newest supported overall: ${describe(supported[0], now)}.` : ''}`
          : 'Every listed cycle is past its end of life; check the project page for what replaces it.',
      );
      out.push('Supported now:', ...supported.map((c) => `- ${describe(c, now)}`));
      return out.join('\n');
    },
  });
}
