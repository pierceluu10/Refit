import { ArrowRight, Check } from '@phosphor-icons/react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { joinWaitlist, waitlistApis } from '../waitlist';
import type { WaitlistResult } from '../waitlist';

export function WaitlistForm() {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<WaitlistResult | null>(null);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSending(true);
    setError('');
    try {
      setResult(await joinWaitlist(String(data.get('email')), data.getAll('apis').map(String)));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSending(false);
    }
  }

  if (result) {
    return (
      <div className="waitlist-done" role="status">
        <span className="sheet-check">
          <Check size={12} weight="bold" />
        </span>
        {result === 'joined'
          ? 'You’re on the list. We’ll email you when your spot opens.'
          : 'You’re already on the list. We’ll be in touch.'}
      </div>
    );
  }

  return (
    <form className="waitlist-form" onSubmit={submit}>
      <div className="waitlist-field">
        <label className="sr-only" htmlFor="waitlist-email">
          Work email
        </label>
        <input
          id="waitlist-email"
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
          placeholder="you@company.com"
        />
        <button className="button button-primary" disabled={sending}>
          {sending ? 'Joining…' : 'Join the waitlist'} <ArrowRight />
        </button>
      </div>
      <fieldset className="waitlist-apis">
        <legend>
          Which APIs do you integrate? <span>Optional</span>
        </legend>
        <div>
          {waitlistApis.map((api) => (
            <label className="waitlist-chip" key={api.id}>
              <input type="checkbox" name="apis" value={api.id} />
              {api.label}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="waitlist-error" role="alert">
        {error}
      </p>
    </form>
  );
}
