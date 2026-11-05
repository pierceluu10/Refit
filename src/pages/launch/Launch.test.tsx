import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Launch } from './Launch';
import { startLaunchPage } from './page.js';

// The page script needs WebGL, video and layout, none of which jsdom has.
vi.mock('./page.js', () => ({ startLaunchPage: vi.fn() }));

describe('launch page', () => {
  it('mounts the page in a shadow root and ends its script on unmount', () => {
    const { container, unmount } = render(<Launch />);
    const shadow = container.querySelector('#main-content')!.shadowRoot!;
    expect(shadow.querySelector('h1')).toHaveTextContent('Agents that handle your integrations.');
    expect(shadow.querySelectorAll('.marks button')).toHaveLength(7);
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
});
