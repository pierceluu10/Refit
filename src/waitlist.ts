export type WaitlistResult = 'joined' | 'already';

// Inserts through Supabase's REST API with the publishable key. Row-level
// security allows inserts only, so the list can't be read from the browser.
export async function joinWaitlist(email: string, apis: string[]): Promise<WaitlistResult> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('The waitlist isn’t connected yet. Please try again later.');
  const response = await fetch(`${url}/rest/v1/waitlist`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ email: email.trim(), apis }),
  });
  if (response.status === 409) return 'already';
  if (!response.ok) throw new Error('Something went wrong. Please try again.');
  return 'joined';
}
