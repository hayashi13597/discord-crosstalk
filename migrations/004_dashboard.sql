ALTER TABLE relay_teams ADD COLUMN display_name text CHECK (display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 80);
CREATE TABLE dashboard_sessions (
  token_hash text PRIMARY KEY, user_id text NOT NULL, user_data jsonb NOT NULL,
  oauth_tokens text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dashboard_sessions_expiry ON dashboard_sessions(expires_at);
CREATE TABLE dashboard_oauth_states (state_hash text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE TABLE dashboard_permissions (
  guild_id text PRIMARY KEY, rules jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dashboard_operations (
  id uuid PRIMARY KEY, guild_id text NOT NULL, actor_id text NOT NULL,
  fingerprint text NOT NULL, status text NOT NULL CHECK (status IN ('Pending','Applied','Failed','Unknown')),
  result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dashboard_operations_retention ON dashboard_operations(created_at);
CREATE TABLE dashboard_move_previews (
  id uuid PRIMARY KEY, guild_id text NOT NULL, actor_id text NOT NULL,
  snapshot jsonb NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
ALTER TABLE voice_move_jobs ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false;
CREATE TABLE dashboard_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, guild_id text NOT NULL, actor_id text NOT NULL,
  action text NOT NULL, target_id text, group_id text, result text NOT NULL, details jsonb NOT NULL DEFAULT '{}',
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dashboard_audit_guild_time ON dashboard_audit(guild_id,changed_at);
