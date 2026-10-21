-- The logo belt on the website added the other providers Refit is aiming at.
alter table public.waitlist drop constraint waitlist_apis_check;

alter table public.waitlist add constraint waitlist_apis_check
  check (apis <@ array[
    'stripe', 'openai', 'anthropic', 'twilio', 'shopify', 'meta', 'gemini',
    'google', 'slack', 'paypal', 'salesforce', 'cloudflare', 'other'
  ]);
