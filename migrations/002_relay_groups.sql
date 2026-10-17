CREATE TABLE relay_guilds (
  guild_id text PRIMARY KEY,
  initialized_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE relay_groups (
  id text PRIMARY KEY,
  guild_id text NOT NULL REFERENCES relay_guilds(guild_id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
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
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  details jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relay_audit_guild_time ON relay_audit (guild_id, changed_at);
