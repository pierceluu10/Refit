import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { AgentDemo } from '../components/AgentDemo';
import { SplitFlap } from '../components/SplitFlap';

describe('waitlist page', () => {
  it('renders the headline, both signups and the labelled demo', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Stop chasing API changelogs.',
    );
    const emails = screen.getAllByLabelText('Work email');
    expect(emails).toHaveLength(2);
    expect(new Set(emails.map((input) => input.id)).size).toBe(emails.length);
    expect(screen.getByText(/^Illustrative example\./).tagName).toBe('FIGCAPTION');
    expect(
      screen.getAllByRole('listitem').map((step) => step.querySelector('h3')?.textContent),
    ).toEqual(expect.arrayContaining(['Detect the change', 'Your review. Your merge.']));
  });
});

describe('agent demo', () => {
  it('starts on the unchanged file with the pause control', () => {
    render(<AgentDemo />);
    expect(screen.getByText('charges.data[0]')).toBeInTheDocument();
    expect(screen.queryByText(/latest_charge;/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Pause the demo' })).toBeVisible();
  });

  it('shows the finished migration without motion under reduced motion', () => {
    vi.mocked(window.matchMedia).mockImplementation(
      (query: string) =>
        ({ matches: query === '(prefers-reduced-motion: reduce)' }) as MediaQueryList,
    );
    const { container } = render(<AgentDemo />);
    const added = [...container.querySelectorAll('[data-state="added"] code')].map(
      (line) => line.textContent,
    );
    expect(added).toEqual([
      '  const charge = payment.latest_charge;',
      "  return typeof charge === 'string' ? charge : charge?.id ?? null;",
    ]);
    expect(container.querySelector('.agent-pr')).toHaveAttribute('data-open', 'true');
    expect(container.querySelector('.agent-cursor')).toHaveAttribute('data-hidden', 'true');
    expect(screen.queryByRole('button', { name: /demo/ })).toBeNull();
  });
});

describe('split-flap', () => {
  it('flips the blank tiles through random characters and lands on the text in order', () => {
    vi.mocked(window.matchMedia).mockImplementation(
      (query: string) => ({ matches: false, media: query }) as MediaQueryList,
    );
    vi.useFakeTimers();
    const { container } = render(<SplitFlap text="02 REVIEW" />);
    const tiles = () =>
      [...container.querySelectorAll('.flap-char')].map((tile) => tile.textContent);
    expect(tiles().join('')).toBe('');
    act(() => vi.advanceTimersByTime(70 * 6));
    expect(tiles()[0]).toBe('0');
    expect(tiles()[8]).not.toBe('');
    act(() => vi.advanceTimersByTime(70 * 20));
    expect(tiles().join('')).toBe('02REVIEW');
    expect(screen.getByText('02 REVIEW')).toHaveClass('sr-only');
    vi.useRealTimers();
  });
});
