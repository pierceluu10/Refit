import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { AgentDemo } from '../components/AgentDemo';

describe('waitlist variants', () => {
  it.each([
    ['/v1', 'APIs change. Your code keeps up.'],
    ['/v2', 'The API changed. Your PR is ready.'],
    ['/v3', 'Stop chasing API changelogs.'],
  ])('%s renders its headline, signup and labelled demo', (path, headline) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(headline);
    const emails = screen.getAllByLabelText('Work email');
    expect(new Set(emails.map((input) => input.id)).size).toBe(emails.length);
    expect(screen.getByText('Illustrative example')).toBeVisible();
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
