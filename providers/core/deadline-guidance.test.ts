// A deadline is when a version stops working or stops being supported. demo-python-app#1 showed
// Werkzeug's 3.0 release date (2023-09-30) as a deadline because every watcher was told
// "when it takes effect or the deadline", which reads a release as the date.
import { describe, expect, it } from 'vitest';
import type { DependencyUsage } from '../../shared/types.ts';
import { platformWatchSystemPrompt } from '../platforms/prompt.ts';
import {
  anyWatchSystemPrompt,
  dependencyWatchSystemPrompt,
  SOURCE_GUIDES,
  watchSystemPrompt,
} from './prompt.ts';

const werkzeug = {
  repo: 'o/r',
  kind: 'library',
  name: 'werkzeug',
  ecosystem: 'pypi',
  version: '2.2.3',
  declaredIn: [{ file: 'pyproject.toml', line: 12 }],
} as DependencyUsage;

describe('deadline guidance in every watcher prompt', () => {
  const prompts = {
    dependency: dependencyWatchSystemPrompt({
      dependency: werkzeug,
      groups: ['packages', 'advisories', 'eol'],
      prompt: '',
      webSearch: false,
    }),
    provider: watchSystemPrompt({ id: 'stripe', name: 'Stripe', prompt: '', sources: [] } as never),
    any: anyWatchSystemPrompt({ name: 'Resend', prompt: '', webSearch: false }),
    platform: platformWatchSystemPrompt({
      dependency: {
        ...werkzeug,
        kind: 'infrastructure',
        name: 'aws-lambda',
        version: 'nodejs16.x',
      },
      webSearch: false,
    }),
  };

  it.each(Object.entries(prompts))(
    'the %s watcher never takes a release date as a deadline',
    (_, prompt) => {
      expect(prompt).not.toMatch(/when it takes effect or the deadline/);
      expect(prompt).toMatch(/release (or announcement )?date is never a deadline/i);
    },
  );

  it('a new major and an advisory carry no deadline of their own', () => {
    expect(SOURCE_GUIDES.packages).toMatch(/A new major has no deadline of its own/);
    expect(SOURCE_GUIDES.advisories).toMatch(/publication date is not a deadline/);
  });

  it('a serverless runtime is due when it stops being supported, not when updates are blocked', () => {
    expect(prompts.platform).toMatch(
      /deprecation date, when the runtime stops getting security patches/,
    );
  });
});
