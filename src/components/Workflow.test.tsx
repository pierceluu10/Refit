import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STEP_DURATION } from '../data';
import { Workflow } from './Workflow';

afterEach(() => vi.useRealTimers());

describe('migration walkthrough', () => {
  it('lets a visitor inspect evidence and pauses autoplay when they choose a stage', () => {
    vi.useFakeTimers();
    render(
      <MemoryRouter>
        <Workflow />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Watch Provider change/ }));
    expect(screen.getByText(/A field changes/)).toBeVisible();
    act(() => vi.advanceTimersByTime(STEP_DURATION * 5));
    expect(screen.getByRole('button', { name: /Watch Provider change/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Play walkthrough' })).toBeVisible();
  });

  it('plays to a verified pull request once and supports replay', () => {
    vi.useFakeTimers();
    render(
      <MemoryRouter>
        <Workflow expanded />
      </MemoryRouter>,
    );
    expect(screen.getByText('paymentIntents.retrieve')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Play walkthrough' }));
    for (let step = 0; step < 4; step += 1) act(() => vi.advanceTimersByTime(STEP_DURATION));
    expect(screen.getByRole('heading', { name: 'Adapt payment charge lookup' })).toBeVisible();
    expect(screen.getByText('Verified')).toBeVisible();
    expect(screen.getByText(/No repository was accessed/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Replay walkthrough' }));
    expect(screen.getByRole('button', { name: /Understand API usage map/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('marks the pull request needs-review and names what is unproven when checks fail', () => {
    render(
      <MemoryRouter>
        <Workflow expanded scenario="failed" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Migrate Checks before and after/ }));
    expect(screen.getByText('Example failure')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Review Pull request/ }));
    expect(screen.getByRole('heading', { name: 'Adapt payment charge lookup' })).toBeVisible();
    expect(screen.getByText('Needs review')).toBeVisible();
    expect(screen.getByText(/Unproven:/)).toBeVisible();
    expect(screen.queryByText('Verified')).not.toBeInTheDocument();
  });

  it('maps unaffected usage and returns a not-affected verdict instead of a migration', () => {
    render(
      <MemoryRouter>
        <Workflow expanded scenario="unaffected" />
      </MemoryRouter>,
    );
    expect(screen.getByText('checkout.sessions.create')).toBeVisible();
    expect(screen.queryByText('paymentIntents.retrieve')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Migrate Checks before and after/ }));
    expect(screen.getByRole('heading', { name: 'Not affected' })).toBeVisible();
    expect(screen.getByText(/No migration or pull request is needed/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Review Pull request/ }));
    expect(
      screen.queryByRole('heading', { name: 'Adapt payment charge lookup' }),
    ).not.toBeInTheDocument();
  });

  it('does not autoplay with reduced motion and cleans up its timer on unmount', () => {
    vi.useFakeTimers();
    vi.mocked(window.matchMedia).mockReturnValueOnce({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    const { unmount } = render(
      <MemoryRouter>
        <Workflow />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Play walkthrough' })).toBeVisible();
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Play walkthrough' }));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
