-- Waitlist signups from the website. The browser can only insert;
-- nobody without the service role can read the list back.
create table public.waitlist (
  id bigint generated always as identity primary key,
  email text not null check (char_length(email) <= 254 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  apis text[] not null default '{}'
    check (apis <@ array['stripe', 'openai', 'anthropic', 'twilio', 'shopify', 'other']),
  created_at timestamptz not null default now()
);

create unique index waitlist_email_key on public.waitlist (lower(email));

alter table public.waitlist enable row level security;

revoke all on public.waitlist from anon, authenticated;
grant insert (email, apis) on public.waitlist to anon;

create policy "Anyone can join the waitlist"
  on public.waitlist for insert to anon
  with check (true);
