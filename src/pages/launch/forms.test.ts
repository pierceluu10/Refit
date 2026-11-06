import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireWaitlistForms } from './forms';

function page() {
  const root = document.createElement('div');
  root.innerHTML = `
    <form class="waitlist" novalidate>
      <input type="email" name="email" />
      <button type="submit">Join the waitlist</button>
      <p class="note"></p>
    </form>`;
  document.body.append(root);
  wireWaitlistForms(root);
  return {
    input: root.querySelector('input')!,
    button: root.querySelector('button')!,
    note: root.querySelector('.note')!,
    submit: (email: string) => {
      root.querySelector('input')!.value = email;
      root.querySelector('form')!.requestSubmit();
    },
  };
}

describe('launch page waitlist forms', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('sends a real signup to the waitlist table', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const { note, submit } = page();
    submit(' dev@example.com ');
    await vi.waitFor(() => expect(note).toHaveTextContent('You’re on the list'));
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://example.supabase.co/rest/v1/waitlist');
    expect(JSON.parse(init.body)).toEqual({ email: 'dev@example.com', apis: [] });
  });

  it('says so when the email is already on the list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 409 })));
    const { note, submit } = page();
    submit('dev@example.com');
    await vi.waitFor(() => expect(note).toHaveTextContent('already on the list'));
  });

  it('rejects a malformed email without calling the waitlist', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { note, submit } = page();
    submit('not-an-email');
    expect(note).toHaveTextContent('doesn’t look right');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('explains a failure and lets the person try again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const { button, input, note, submit } = page();
    submit('dev@example.com');
    await vi.waitFor(() => expect(note).toHaveTextContent('Something went wrong'));
    expect(button).toBeEnabled();
    expect(input).toHaveValue('dev@example.com');
  });

  it('ignores a second submit while the first is sending', async () => {
    let finish = (_: Response) => {};
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (finish = resolve)));
    vi.stubGlobal('fetch', fetch);
    const { note, submit } = page();
    submit('dev@example.com');
    submit('dev@example.com');
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(new Response(null, { status: 201 }));
    await vi.waitFor(() => expect(note).toHaveTextContent('You’re on the list'));
  });
});
