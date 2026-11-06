import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Docs } from './Docs';

function renderDocs(path = '/docs') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Docs />
    </MemoryRouter>,
  );
}

function section(id: string) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`No section with id ${id}`);
  return element;
}

const refitFile = `paused: true # stop scans and PRs for this repo
ignore: # dependencies Refit should leave alone
  - stripe
  - node
`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('docs', () => {
  it.each([
    ['what-refit-watches', 'What Refit watches'],
    ['what-a-pr-contains', 'What a PR contains'],
    ['hard-limits', 'The hard limits'],
    ['pause-or-ignore', 'Pause or ignore with .refit.yml'],
  ])('has a section #%s headed "%s" that the sidebar links to', (id, heading) => {
    renderDocs();
    expect(within(section(id)).getByRole('heading', { level: 2, name: heading })).toBeVisible();
    const sidebar = screen.getByRole('navigation', { name: 'Documentation topics' });
    const links = within(sidebar).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toContain(`#${id}`);
  });

  it('has one h1 and marks the topic in the URL as selected', () => {
    renderDocs('/docs#hard-limits');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const sidebar = screen.getByRole('navigation', { name: 'Documentation topics' });
    expect(within(sidebar).getByRole('link', { name: 'The hard limits' })).toHaveClass('selected');
    expect(within(sidebar).getByRole('link', { name: 'What Refit watches' })).not.toHaveClass(
      'selected',
    );
  });

  it('lists every category Refit watches, in plain words', () => {
    renderDocs();
    const rows = within(within(section('what-refit-watches')).getByRole('table'))
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.querySelector('td')?.textContent);
    expect(rows).toEqual([
      'Language runtimes',
      'Frameworks',
      'Libraries',
      'Security advisories',
      'AI models',
      'Third-party APIs',
      'Container images',
      'CI',
      'Kubernetes and cloud',
      'Serverless runtimes',
      'App stores and mobile',
      'Browsers',
      'Encryption and login',
      'Payment rules',
      'Laws and regulations',
    ]);
  });

  it('is honest about rules and languages', () => {
    renderDocs();
    const text = section('what-refit-watches').textContent;
    expect(text).toContain('never claims a codebase is compliant');
    expect(text).toContain('never gives legal advice');
    expect(text).toContain('needs-review PR listing what a person or lawyer must confirm');
    expect(text).toContain('JavaScript, TypeScript and Python');
    expect(text).toContain('Code in other languages is found and reported');
    expect(text).toContain('still gets a needs-review PR with notes');
  });

  it('says what a PR contains and that it stays a draft', () => {
    renderDocs();
    const text = section('what-a-pr-contains').textContent;
    expect(text).toContain('a link to the source and a quote from it');
    expect(text).toContain('before and after');
    expect(text).toContain('What’s unproven');
    expect(text).toContain('Every PR is a draft');
    expect(text).toContain('Refit never merges one');
  });

  it('states exactly the four hard limits', () => {
    renderDocs();
    const limits = within(section('hard-limits'))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(limits).toEqual([
      'Untrusted repo code runs only in the sandbox.',
      'A run-level dollar cap.',
      'PRs only, never pushing to the default branch and never merging.',
      'Never printing or committing secrets.',
    ]);
  });

  it('documents the .refit.yml format and copies exactly that snippet', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderDocs();
    const pause = section('pause-or-ignore');
    expect(pause.querySelector('pre')?.textContent).toBe(refitFile);
    expect(pause.textContent).toContain('paused: true');
    expect(pause.textContent).toContain('  - stripe\n  - node\n');
    expect(pause.textContent).not.toContain('pause: true');
    expect(pause.textContent).not.toContain('dependency:');
    expect(pause.textContent).not.toContain('until:');
    expect(pause.textContent).toContain('at the root of a repo');
    expect(pause.textContent).toContain('optional');
    expect(pause.textContent).toContain('matches a dependency or API by name, in any case');
    expect(pause.textContent).toContain('A malformed or unknown entry never stops a scan');
    expect(pause.textContent).toContain('the valid parts still apply');
    expect(within(pause).getByRole('link', { name: 'What’s behind' })).toHaveAttribute(
      'href',
      '/app',
    );
    fireEvent.click(within(pause).getByRole('button', { name: 'Copy configuration' }));
    expect(writeText).toHaveBeenCalledWith(refitFile);
    expect(await within(pause).findByRole('status')).toHaveTextContent('Copied to clipboard');
  });

  it('links to pricing once from the page and to onboarding to get started', () => {
    renderDocs();
    const main = within(screen.getByRole('main'));
    expect(main.getAllByRole('link', { name: /pricing/i })).toHaveLength(1);
    expect(main.getByRole('link', { name: 'pricing' })).toHaveAttribute('href', '/pricing');
    expect(main.getByRole('link', { name: 'Get started' })).toHaveAttribute('href', '/onboarding');
    expect(screen.getByRole('main').textContent).not.toMatch(/\$\d/);
  });

  it.each(['migration', 'migrate', 'provider', 'preview', 'replay', 'sample'])(
    'has no leftover "%s" copy from the old page',
    (word) => {
      renderDocs();
      expect(screen.getByRole('main').textContent?.toLowerCase()).not.toContain(word);
    },
  );

  it('never uses the old file name without its leading dot', () => {
    renderDocs();
    expect(screen.getByRole('main').textContent).not.toMatch(/[^.]refit\.yml/);
  });
});
