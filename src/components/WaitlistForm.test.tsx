import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WaitlistForm } from './WaitlistForm';

function submit(email: string, ...apis: string[]) {
  render(<WaitlistForm />);
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: email } });
  for (const api of apis) fireEvent.click(screen.getByRole('button', { name: api }));
  fireEvent.click(screen.getByRole('button', { name: /Join the waitlist/ }));
}

describe('waitlist form', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('inserts the email and chosen APIs with only the publishable key', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    submit(' dev@example.com ', 'Stripe', 'OpenAI');
    expect(await screen.findByText(/You’re on the list/)).toBeVisible();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://example.supabase.co/rest/v1/waitlist');
    expect(init.headers).toEqual({
      apikey: 'sb_publishable_test',
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    });
    expect(JSON.parse(init.body)).toEqual({ email: 'dev@example.com', apis: ['stripe', 'openai'] });
  });

  it('toggles a logo on and off and keeps both belt copies in step', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const { container } = render(<WaitlistForm />);
    const meta = screen.getByRole('button', { name: 'Meta' });
    const copies = container.querySelectorAll('.logo-group');
    const hiddenMeta = [...copies[1].querySelectorAll('button')].find(
      (button) => button.textContent === 'Meta',
    )!;
    expect(copies[1]).toHaveAttribute('aria-hidden', 'true');
    expect(hiddenMeta).toHaveAttribute('tabindex', '-1');

    fireEvent.click(hiddenMeta);
    expect(meta).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Shopify' }));
    fireEvent.click(meta);
    expect(hiddenMeta).toHaveAttribute('aria-pressed', 'false');

    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'dev@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Join the waitlist/ }));
    await screen.findByText(/You’re on the list/);
    expect(JSON.parse(fetch.mock.calls[0][1].body).apis).toEqual(['shopify']);
  });

  it('treats a duplicate email as already joined', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 409 })));
    submit('dev@example.com');
    expect(await screen.findByText(/already on the list/)).toBeVisible();
  });

  it('keeps the form and explains a failure', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    submit('dev@example.com');
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByLabelText('Work email')).toHaveValue('dev@example.com');
  });

  it('says so when Supabase is not configured', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');
    submit('dev@example.com');
    expect(await screen.findByRole('alert')).toHaveTextContent('isn’t connected yet');
  });
});
