CREATE TABLE IF NOT EXISTS leader_assignments (
  guild_id text NOT NULL,
  team_id smallint NOT NULL CHECK (team_id BETWEEN 1 AND 3),
  user_id text NOT NULL,
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (guild_id, team_id),
  UNIQUE (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS leader_audit (
  id INTEGER PRIMARY KEY,
  guild_id text NOT NULL,
  team_id smallint NOT NULL CHECK (team_id BETWEEN 1 AND 3),
  old_user_id text,
  new_user_id text,
  actor_id text NOT NULL,
  changed_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS leader_audit_guild_time ON leader_audit (guild_id, changed_at);

CREATE TABLE relay_guilds (
  guild_id text PRIMARY KEY,
  initialized_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE relay_groups (
  id text PRIMARY KEY,
  guild_id text NOT NULL REFERENCES relay_guilds(guild_id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  state text NOT NULL CHECK (state IN ('active', 'paused')),
  legacy boolean NOT NULL DEFAULT false,
  UNIQUE (guild_id, id)
);
CREATE UNIQUE INDEX relay_group_names ON relay_groups (guild_id, lower(name));
CREATE UNIQUE INDEX relay_legacy_group ON relay_groups (guild_id) WHERE legacy;
CREATE TABLE relay_workers (
  guild_id text NOT NULL REFERENCES relay_guilds(guild_id),
  worker_id integer NOT NULL CHECK (worker_id > 0),
  user_id text,
  PRIMARY KEY (guild_id, worker_id),
  UNIQUE (guild_id, user_id)
);
CREATE TABLE relay_teams (
  id text PRIMARY KEY,
  guild_id text NOT NULL,
  group_id text NOT NULL,
  channel_id text NOT NULL,
  leader_id text,
  worker_id integer NOT NULL,
  legacy_slot smallint CHECK (legacy_slot BETWEEN 1 AND 3),
  FOREIGN KEY (guild_id, group_id) REFERENCES relay_groups(guild_id, id),
  FOREIGN KEY (guild_id, worker_id) REFERENCES relay_workers(guild_id, worker_id),
  UNIQUE (guild_id, channel_id),
  UNIQUE (guild_id, worker_id),
  UNIQUE (guild_id, leader_id),
  UNIQUE (guild_id, legacy_slot)
);
CREATE TABLE relay_audit (
  id INTEGER PRIMARY KEY,
  guild_id text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  details text NOT NULL,
  changed_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX relay_audit_guild_time ON relay_audit (guild_id, changed_at);

CREATE TABLE voice_move_jobs (
  id text PRIMARY KEY,
  guild_id text NOT NULL,
  actor_id text NOT NULL,
  sources text NOT NULL,
  destination_id text,
  snapshot_at text,
  bots_skipped integer NOT NULL DEFAULT 0 CHECK (bots_skipped >= 0),
  status text NOT NULL CHECK (status IN ('Running', 'Completed', 'Partially Completed', 'Cancelled', 'Failed', 'Interrupted')),
  reason text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at text
);
CREATE UNIQUE INDEX voice_move_one_running ON voice_move_jobs (guild_id) WHERE status = 'Running';
CREATE INDEX voice_move_retention ON voice_move_jobs (guild_id, finished_at);
CREATE TABLE voice_move_members (
  job_id text NOT NULL REFERENCES voice_move_jobs(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  source_id text NOT NULL,
  ordinal integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'moved', 'skipped', 'failed', 'unknown')),
  reason text,
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (job_id, user_id),
  UNIQUE (job_id, ordinal)
);
