# Website waitlist

The home page is in waitlist mode: a signup form, the interactive demo and a short explanation. Signups go to a Supabase table through its REST API. There is no server of our own.

## Set up Supabase

1. Create a Supabase project.
2. In the SQL editor, run [`supabase/migrations/20261015000000_waitlist.sql`](../supabase/migrations/20261015000000_waitlist.sql). It creates `public.waitlist` with row-level security. Browsers can insert an email and the APIs they picked, and nothing else. They cannot read, update or delete rows.
   Then run every later file in that folder in name order. [`20261020000000_waitlist_more_apis.sql`](../supabase/migrations/20261020000000_waitlist_more_apis.sql) widens the allowed API ids to match the logo belt; without it, signups that pick a newer logo fail.
3. Copy the project URL and the **publishable** key (Project Settings → API Keys) into `.env.local`:

   ```sh
   VITE_SUPABASE_URL=https://<project>.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   ```

   Set the same two variables on the host that builds the site. Never use the secret key here: Vite bundles every `VITE_` variable into public JavaScript.

4. Run `npm run dev` and join with a test email. The row appears in the Table Editor.

Without these variables, the form shows "The waitlist isn't connected yet" instead of failing silently.

## Behavior

- Emails are unique, ignoring case. A repeat signup shows "You're already on the list".
- The optional APIs are limited to the values in `src/waitlist.ts`, which the table also enforces.
- Read the list in the Supabase dashboard or with the secret key from a trusted machine.

## Known limits

The insert endpoint is public, like any static-site form. If spam shows up, add a CAPTCHA (Supabase supports Turnstile and hCaptcha) or move the insert behind an Edge Function with rate limiting.

## Back to the full landing page

The previous landing page is still in `src/pages/Landing.tsx`. To restore it, point the `/` route in `src/App.tsx` back at `Landing`.
