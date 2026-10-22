<!-- refit-report -->
# What `agentset-ai/agentset` depends on

Counted on 2026-10-22 at commit `03283cc6383b`, from files only: Refit ran no code and contacted no provider.

## Next step

Add the Stripe agent with `refit agents --add stripe` and approve the repository, so Refit can propose migrations for its breaking changes.

## Integrations

| Provider | Package | Declared | Locked | Refit |
|---|---|---|---|---|
| Stripe | `stripe` in `packages/stripe/package.json` | `^18.0.0` |  | Agent available: migrates breaking changes once added |
| Resend | `resend` in `apps/web/package.json` | `^6.7.0` |  | Reports only |
| Resend | `resend` in `packages/emails/package.json` | `^6.7.0` |  | Reports only |

## Deadlines

No live code depends on a deadline in the registry.

Named only outside live code (tests, comments, catalogs): `openai-2027-04-01-gpt-5-1`.

## AI model calls

No OpenAI or Anthropic text-generation calls traced.

## Hosts Refit does not track

None.