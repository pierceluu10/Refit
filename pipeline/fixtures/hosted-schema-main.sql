CREATE TABLE IF NOT EXISTS refit_installations (
  id bigint PRIMARY KEY,
  owner text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'suspended', 'deleted')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refit_installation_repositories (
  installation_id bigint NOT NULL REFERENCES refit_installations (id),
  repository text NOT NULL,
  github_id bigint NOT NULL,
  PRIMARY KEY (installation_id, repository)
);
CREATE TABLE IF NOT EXISTS refit_deliveries (
  id text PRIMARY KEY,
  hash text NOT NULL,
  event text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refit_approvals (
  repository text NOT NULL,
  base text NOT NULL,
  fingerprint text NOT NULL,
  approval jsonb NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository, base)
);
CREATE TABLE IF NOT EXISTS refit_targets (
  id text PRIMARY KEY,
  repository text NOT NULL,
  base text NOT NULL,
  integration text,
  installation_id bigint NOT NULL REFERENCES refit_installations (id),
  fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('enrolled', 'cancelled')),
  message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refit_jobs (
  id bigserial PRIMARY KEY,
  target_id text NOT NULL REFERENCES refit_targets (id),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'finished', 'failed', 'cancelled')),
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  receipt jsonb
);
-- An operator retry permits one fresh attempt of a cached failure; successful results stay cached.
ALTER TABLE refit_jobs ADD COLUMN IF NOT EXISTS retry boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS refit_jobs_open ON refit_jobs (target_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS refit_targets_installation ON refit_targets (installation_id);
-- No policies: data APIs such as Supabase's see nothing; the owning worker role bypasses RLS.
ALTER TABLE refit_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE refit_installation_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE refit_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE refit_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE refit_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE refit_jobs ENABLE ROW LEVEL SECURITY;
