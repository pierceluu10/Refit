import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STEP_DURATION } from '../data';
import { Workflow } from './Workflow';

afterEach(() => vi.useRealTimers());

describe('migration walkthrough', () => {
  it('lets a visitor inspect evidence and pauses autoplay when they choose a stage', () => {
    vi.useFakeTimers();
    render(<MemoryRouter><Workflow /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Detect Provider change/ }));
    expect(screen.getByText(/A field changes/)).toBeVisible();
    act(() => vi.advanceTimersByTime(STEP_DURATION * 5));
    expect(screen.getByRole('button', { name: /Detect Provider change/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Play walkthrough' })).toBeVisible();
  });

  it('plays to the final step once and supports replay', () => {
    vi.useFakeTimers();
    render(<MemoryRouter><Workflow expanded /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Play walkthrough' }));
    for (let step = 0; step < 4; step += 1) act(() => vi.advanceTimersByTime(STEP_DURATION));
    expect(screen.getByRole('heading', { name: 'Adapt payment charge lookup' })).toBeVisible();
    expect(screen.getByText(/No repository was accessed/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Replay walkthrough' }));
    expect(screen.getByRole('button', { name: /Detect Provider change/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('never shows a draft PR when the example validation fails', () => {
    render(<MemoryRouter><Workflow expanded scenario="failed" /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Validate Project checks/ }));
    expect(screen.getByText('Example failure')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Review Draft pull request/ }));
    expect(screen.getByRole('heading', { name: 'No passing checks. No PR.' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Adapt payment charge lookup' })).not.toBeInTheDocument();
  });

  it('does not propose a migration for unaffected usage', () => {
    render(<MemoryRouter><Workflow expanded scenario="unaffected" /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Understand Code impact/ }));
    expect(screen.getByRole('heading', { name: 'No affected usage' })).toBeVisible();
    expect(screen.getByText(/No migration or pull request is needed/)).toBeVisible();
  });

  it('does not autoplay with reduced motion and cleans up its timer on unmount', () => {
    vi.useFakeTimers();
    vi.mocked(window.matchMedia).mockReturnValueOnce({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
    const { unmount } = render(<MemoryRouter><Workflow /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Play walkthrough' })).toBeVisible();
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Play walkthrough' }));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
