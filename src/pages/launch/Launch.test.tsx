import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Launch } from './Launch';
import { startLaunchPage } from './page.js';

// The page script needs WebGL, video and layout, none of which jsdom has.
vi.mock('./page.js', () => ({ startLaunchPage: vi.fn() }));

function renderShadow() {
  const view = render(<Launch />);
  return { ...view, shadow: view.container.querySelector('#main-content')!.shadowRoot! };
}

describe('launch page', () => {
  it('mounts the page in a shadow root and ends its script on unmount', () => {
    const { shadow, unmount } = renderShadow();
    expect(shadow.querySelector('h1')).toHaveTextContent('Software that never falls behind.');
    expect(shadow.querySelectorAll('.marks button')).toHaveLength(4);
    expect(shadow.querySelector('#hero-video source')).toHaveAttribute(
      'src',
      '/launch/hero-phone.mp4',
    );
    expect(shadow.textContent).not.toMatch(/Mockup only/);
    expect(document.documentElement).toHaveClass('launch-root');

    const signal = vi.mocked(startLaunchPage).mock.calls.at(-1)![1];
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
    expect(document.documentElement).not.toHaveClass('launch-root');
  });

  it('tells the story in four named steps, one card and one numeral each', () => {
    const { shadow } = renderShadow();
    const titles = [...shadow.querySelectorAll('.step-title')].map((title) => title.textContent);
    expect(titles.map((title) => title!.split(' ')[0])).toEqual([
      'Install',
      'Scan',
      'Fix',
      'Prove',
    ]);
    expect(shadow.querySelectorAll('.leaf')).toHaveLength(titles.length);
    const labels = [...shadow.querySelectorAll('.marks button')].map((mark) =>
      mark.getAttribute('aria-label'),
    );
    expect(labels).toEqual(titles);
  });

  it('labels the example and leaves no old pitch or invented customer behind', () => {
    const { shadow } = renderShadow();
    expect(shadow.querySelector('.story-note')).toHaveTextContent('Illustrative example');
    const markup = shadow.innerHTML;
    for (const leftover of [
      /integrations/i,
      /files\.upload/,
      /coding agent/i,
      /acme/i,
      /API docs/,
      /refit-agent/,
    ]) {
      expect(markup).not.toMatch(leftover);
    }
  });

  it('links to pricing and docs and keeps the waitlist as the main action', () => {
    const { shadow } = renderShadow();
    const links = [...shadow.querySelectorAll('.nav-link')].map((link) => [
      link.textContent,
      link.getAttribute('href'),
    ]);
    expect(links).toEqual([
      ['Pricing', '/pricing'],
      ['Docs', '/docs'],
    ]);
    expect(shadow.querySelector('.nav-cta')).toHaveTextContent('Join the waitlist');
    expect(shadow.querySelectorAll('form.waitlist')).toHaveLength(2);
    expect(shadow.textContent).not.toMatch(/Install the GitHub App/);
  });
});
