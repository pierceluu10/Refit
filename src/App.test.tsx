import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from './App';

function NavigationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Current address">
        {location.pathname}
        {location.search}
      </output>
      <button onClick={() => navigate(-1)}>Browser back</button>
    </>
  );
}

function renderRoute(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <NavigationProbe />
    </MemoryRouter>,
  );
}

describe('workspace navigation', () => {
  it('sets the home tab title after the React app loads', () => {
    renderRoute('/');
    expect(document.title).toBe('Refit: Keep your integrations current');
  });

  it('redirects old /app links to the same sample workspace page', () => {
    renderRoute('/app/runs/validation-failure?tab=review');
    expect(screen.getByLabelText('Current address')).toHaveTextContent(
      '/sample/runs/validation-failure?tab=review',
    );
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('keeps repository filters in the URL and restores them when navigating back', () => {
    renderRoute('/sample/repositories');
    fireEvent.change(screen.getByLabelText('Search repositories'), { target: { value: 'api' } });
    fireEvent.change(screen.getByLabelText('Filter repositories by status'), {
      target: { value: 'Affected' },
    });
    expect(screen.getByLabelText('Current address')).toHaveTextContent('q=api&status=Affected');
    expect(screen.queryByText('acme / web')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /View acme \/ api/ }));
    expect(screen.getByRole('heading', { name: 'Impact evidence' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
    expect(screen.getByLabelText('Search repositories')).toHaveValue('api');
    expect(screen.getByLabelText('Filter repositories by status')).toHaveValue('Affected');
  });

  it('recovers from an empty repository search', () => {
    renderRoute('/sample/repositories?q=missing');
    expect(screen.getByRole('heading', { name: 'No repositories match.' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByLabelText('Search repositories')).toHaveValue('');
    expect(screen.getByText('acme / web')).toBeVisible();
  });

  it('preserves failed-run tabs across deep links and never claims publication', () => {
    renderRoute('/sample/runs/validation-failure?tab=review');
    expect(screen.getByRole('heading', { name: 'No passing checks. No PR.' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Validation' }));
    expect(screen.getByText('Example failure')).toBeVisible();
    expect(screen.getByLabelText('Current address')).toHaveTextContent('tab=validation');
  });

  it('falls back to the default scenario for an unknown demo query', () => {
    renderRoute('/demo?scenario=unknown');
    expect(screen.getByRole('button', { name: 'Affected code' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Checks fail' }));
    expect(screen.getByLabelText('Current address')).toHaveTextContent('scenario=failed');
  });

  it('contains keyboard focus in the workspace drawer and restores it on Escape', () => {
    renderRoute('/sample');
    const trigger = screen.getByRole('button', { name: 'Open workspace navigation' });
    fireEvent.click(trigger);
    const drawer = screen.getByRole('dialog', { name: 'Workspace navigation' });
    expect(
      within(drawer).getByRole('button', { name: 'Close workspace navigation' }),
    ).toHaveFocus();
    const last = within(drawer).getByRole('link', { name: 'Back to Refit' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(within(drawer).getByRole('link', { name: 'Refit home' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('handles unknown resource addresses with a recovery link', () => {
    renderRoute('/sample/repositories/not-real');
    expect(screen.getByRole('heading', { name: 'Nothing at this address.' })).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: 'Back to overview' }));
    expect(
      screen.getByRole('heading', { name: 'A little change. The full picture.' }),
    ).toBeVisible();
  });
});
