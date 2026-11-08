import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Account } from './Account';

vi.unmock('./Account');

const respondWith = (session: unknown) => {
  const fetchMock = vi.fn(
    async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(session), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const show = (path = '/app') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Account />
    </MemoryRouter>,
  );

afterEach(() => vi.unstubAllGlobals());

describe('Account', () => {
  it('offers GitHub sign-in when signed out', async () => {
    respondWith({ signedIn: false, canSignIn: true });
    show();
    const link = await screen.findByRole('link', { name: /sign in with github/i });
    expect(link.getAttribute('href')).toBe('/api/auth/login');
  });

  it('says so when a sign-in failed', async () => {
    respondWith({ signedIn: false, canSignIn: true });
    show('/app?login=failed');
    expect((await screen.findByRole('alert')).textContent).toContain('didn’t finish');
    expect(screen.getByRole('link', { name: /try again/i })).toBeTruthy();
  });

  it('shows nothing when login is not configured', async () => {
    const fetchMock = respondWith({ signedIn: false, canSignIn: false });
    const { container } = show();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('shows the signed-in login and logs out with a POST', async () => {
    const fetchMock = respondWith({ signedIn: true, login: 'alice', orgs: ['org-a'] });
    show();
    expect(await screen.findByText('alice')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /log out/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' }),
    );
  });
});
