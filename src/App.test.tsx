import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';

function renderRoute(path: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<!doctype html>')));
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

// The launch page's script needs WebGL and video, which jsdom doesn't have.
vi.mock('./pages/launch/page.js', () => ({ startLaunchPage: vi.fn() }));

describe('site routes', () => {
  it('sets the home tab title after the React app loads', () => {
    renderRoute('/');
    expect(document.title).toBe('Refit: Software that never falls behind');
  });

  it.each([
    ['/pricing', 'Refit: Pricing'],
    ['/onboarding', 'Refit: Get started'],
    ['/docs', 'Refit: Documentation'],
    ['/app', 'Refit: Dashboard'],
  ])('serves %s with its own tab title', (path, title) => {
    renderRoute(path);
    expect(document.title).toBe(title);
    expect(screen.getByRole('heading', { level: 1 })).toBeVisible();
  });

  it('contains keyboard focus in the dashboard drawer and restores it on Escape', () => {
    renderRoute('/app/runs');
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

  it('links the Platforms and rules page from the dashboard', () => {
    renderRoute('/app/runs');
    fireEvent.click(screen.getByRole('link', { name: 'Platforms and rules' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Platforms and rules' })).toBeVisible();
  });

  it('recovers from an unknown dashboard address', () => {
    renderRoute('/app/not-real');
    expect(screen.getByRole('heading', { name: 'Nothing at this address.' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to What’s behind' })).toHaveAttribute(
      'href',
      '/app',
    );
  });

  it.each(['/sample', '/demo', '/directions/film', '/app/settings'])(
    'no longer serves %s',
    (path) => {
      renderRoute(path);
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        /This page doesn’t fit|Nothing at this address/,
      );
    },
  );
});
