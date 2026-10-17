CREATE TABLE IF NOT EXISTS leader_assignments (
  guild_id text NOT NULL,
  team_id smallint NOT NULL CHECK (team_id BETWEEN 1 AND 3),
  user_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, team_id),
  UNIQUE (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS leader_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id text NOT NULL,
  team_id smallint NOT NULL CHECK (team_id BETWEEN 1 AND 3),
  old_user_id text,
  new_user_id text,
  actor_id text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leader_audit_guild_time ON leader_audit (guild_id, changed_at);
