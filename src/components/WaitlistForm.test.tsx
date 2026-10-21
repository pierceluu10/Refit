import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WaitlistForm } from './WaitlistForm';

function submit(email: string) {
  render(<WaitlistForm />);
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: /Join the waitlist/ }));
}

describe('waitlist form', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('inserts the email with only the publishable key', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    submit(' dev@example.com ');
    expect(await screen.findByText(/You’re on the list/)).toBeVisible();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://example.supabase.co/rest/v1/waitlist');
    expect(init.headers).toEqual({
      apikey: 'sb_publishable_test',
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    });
    expect(JSON.parse(init.body)).toEqual({ email: 'dev@example.com', apis: [] });
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
