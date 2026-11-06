-- Sketch of the Postgres table an AuditStore implementation would use when the trail moves off
-- local JSON. Not applied anywhere yet. Rows are append-only: grant INSERT and SELECT, not UPDATE
-- or DELETE.
create table if not exists refit_audit (
  id bigserial primary key,
  at timestamptz not null,
  repo text not null,
  change_id text not null,
  obligation_id text,
  action text not null check (
    action in ('detected', 'matched', 'not-affected', 'pr-opened', 'pr-updated', 'merged', 'closed')
  ),
  pr text,
  evidence jsonb not null default '[]',
  actor text not null default 'refit'
);
create index if not exists refit_audit_repo_at on refit_audit (repo, at);
