import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { AgentDemo } from '../components/AgentDemo';

describe('homepage', () => {
  it('renders the headline, both signups, the six steps and the closing section', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Refit fixed it.');
    const emails = screen.getAllByLabelText('Work email');
    expect(emails).toHaveLength(2);
    expect(new Set(emails.map((input) => input.id)).size).toBe(emails.length);
    expect(
      screen.getByRole('list', { name: 'How Refit works, step by step' }).children,
    ).toHaveLength(6);
    expect(screen.getByRole('heading', { level: 2, name: /^Stop chasing/ })).toBeInTheDocument();
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
