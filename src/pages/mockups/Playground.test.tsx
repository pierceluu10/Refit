import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaygroundSection } from './Playground';

// Long enough for every step of a run.
const RUN_MS = 10_000;

function runOn(repository: string) {
  const card = screen.getByText(repository).closest('article')!;
  fireEvent.click(within(card).getByRole('button', { name: 'Run Refit here' }));
  act(() => {
    vi.advanceTimersByTime(RUN_MS);
  });
}

describe('playground', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drafts a pull request where the agent silently drops payment_method_types', () => {
    render(<PlaygroundSection />);
    runOn('storefront');
    expect(screen.getByText('Draft pull request ready for review')).toBeInTheDocument();
    expect(screen.getByText('Checks pass. Behaviour changed.')).toBeInTheDocument();
    expect(screen.getByText("allowed_payment_method_types: ['card'],")).toBeInTheDocument();
  });

  it('leaves a repository alone when the change does not reach it', () => {
    render(<PlaygroundSection />);
    fireEvent.click(screen.getByRole('radio', { name: /gpt-4\.5-preview retired/ }));
    runOn('billing-api');
    expect(screen.getByText('No pull request')).toBeInTheDocument();
    expect(screen.queryByText('Draft pull request ready for review')).toBeNull();
  });

  it('clears the run when another API change is picked', () => {
    render(<PlaygroundSection />);
    runOn('storefront');
    fireEvent.click(screen.getByRole('radio', { name: /current_period_end/ }));
    expect(screen.getByText(/Drop the mark on a repository/)).toBeInTheDocument();
  });
});
