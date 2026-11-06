// model_replacement: a model's replacement, retirement date and request-shape differences. OpenAI
// answers from its own pack; Anthropic and Google from a dated snapshot, checked against the live page.

import { readFileSync } from 'node:fs';
import type { AgentTool } from '../../shared/types.ts';
import { createToolPack as createOpenAiPack } from '../openai/tools.ts';
import { closest, defineTool, fetchPage, pageToText, str } from '../toolkit/index.ts';
import { today, type UpgradeToolOptions } from './options.ts';

type ModelRow = {
  id: string;
  status: string;
  retirementDate: string | null;
  replacement: string | null;
  quote: string;
};
type ProviderSnapshot = {
  source: string;
  retrieved: string;
  models: ModelRow[];
  requestNotes: { note: string; url: string }[];
};

const SNAPSHOTS = JSON.parse(
  readFileSync(new URL('./data/model-retirements.json', import.meta.url), 'utf8'),
) as Record<string, ProviderSnapshot>;

const OPENAI_NOTES = JSON.parse(
  readFileSync(new URL('../openai/tools-data/request-notes.json', import.meta.url), 'utf8'),
) as { reasoningModels: { note: string; source: string } };

/** The provider a name or model id points at. Only a head start: an unknown one still gets an answer. */
export function providerFor(provider: string | undefined, model: string): string | undefined {
  const text = `${provider ?? ''} ${model}`.toLowerCase();
  if (/anthropic|claude/.test(text)) return 'anthropic';
  if (/google|gemini|vertex|palm/.test(text)) return 'google';
  if (/openai|\bgpt|\bo[134]\b|\bo[134]-|davinci|whisper|dall-e|\bft:/.test(text)) return 'openai';
  return undefined;
}

// Cloud-prefixed ids carry the provider's model id inside them.
function normalize(model: string): string {
  return model
    .trim()
    .replace(/^models\//, '')
    .replace(/^(?:[a-z-]+\.)?anthropic\./, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/@(\d+)$/, '-$1');
}

function findRow(rows: ModelRow[], model: string): ModelRow | undefined {
  const id = normalize(model);
  return (
    rows.find((row) => row.id === id) ??
    rows.find((row) => id.startsWith(`${row.id}-`) || row.id.startsWith(`${id}-`))
  );
}

export function createModelReplacementTool(options: UpgradeToolOptions = {}): AgentTool {
  const openAiLookup = createOpenAiPack(options).tools.find(
    (tool) => tool.name === 'openai_model_lookup',
  );
  return defineTool({
    name: 'model_replacement',
    description:
      "Look up an AI model id: its status, retirement date, the provider's recommended replacement and known request-shape differences (parameters a newer model rejects, for example). Reads OpenAI, Anthropic and Google data. The replacement is what the provider recommends; check it against what the code needs. Informational.",
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'E.g. "openai", "anthropic" or "google".' },
        model: { type: 'string', description: 'The model id as written in the code.' },
      },
      required: ['model'],
    },
    run: async (input, context) => {
      const model = str(input, 'model');
      if (!model) return 'Pass "model": the id as written in the code, e.g. "gpt-4o".';
      const provider = providerFor(str(input, 'provider'), model);
      if (provider === 'openai' && openAiLookup) {
        const { note, source } = OPENAI_NOTES.reasoningModels;
        return [
          await openAiLookup.run({ model, now: today(options) }, context),
          `Request-shape notes: ${note} (${source})`,
          'To check a specific request against the replacement, use openai_check_request where it is available.',
        ].join('\n\n');
      }
      const snapshot = provider ? SNAPSHOTS[provider] : undefined;
      if (!snapshot) {
        return `No retirement data for ${str(input, 'provider') ?? 'this provider'}. Read the provider's deprecations page with fetch_changelog or search_docs, and look for "${model}".`;
      }
      const row = findRow(snapshot.models, model);
      const out = [`${provider} model ${model}:`];
      if (row) {
        out.push(
          `Status on ${snapshot.retrieved}: ${row.status}.`,
          `Retirement date: ${row.retirementDate ?? 'not listed'}.`,
          `Recommended replacement: ${row.replacement ?? 'none listed'}.`,
          `The page says: "${row.quote}"`,
        );
      } else {
        const near = closest(
          normalize(model),
          snapshot.models.map((m) => m.id),
        );
        out.push(
          `Not in the ${snapshot.retrieved} snapshot${near.length ? `; closest: ${near.join(', ')}` : ''}. It may be new, an alias or a typo.`,
        );
      }
      const page = await fetchPage(snapshot.source, options);
      if (page.ok) {
        const id = normalize(model);
        const lines = pageToText(page.text, page.contentType, page.url)
          .split('\n')
          .filter((line) => line.includes(id))
          .slice(0, 5)
          .map((line) => `- ${line.trim().slice(0, 300)}`);
        out.push(
          lines.length
            ? ['The live page today:', ...lines].join('\n')
            : `The live page does not mention ${id} word for word.`,
        );
      } else {
        out.push(`Could not read the live page (${page.error}); the snapshot may be out of date.`);
      }
      if (snapshot.requestNotes.length) {
        out.push(
          [
            'Request-shape notes:',
            ...snapshot.requestNotes.map((note) => `- ${note.note} (${note.url})`),
          ].join('\n'),
        );
      }
      out.push(`Source: ${snapshot.source}`);
      return out.join('\n');
    },
  });
}
