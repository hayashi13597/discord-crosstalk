-- Preserve channel and worker assignments while removing obsolete leader mapping.
CREATE TABLE relay_teams_current (
  id text PRIMARY KEY,
  guild_id text NOT NULL,
  group_id text NOT NULL,
  channel_id text NOT NULL,
  worker_id integer NOT NULL,
  FOREIGN KEY (guild_id, group_id) REFERENCES relay_groups(guild_id, id),
  FOREIGN KEY (guild_id, worker_id) REFERENCES relay_workers(guild_id, worker_id),
  UNIQUE (guild_id, channel_id),
  UNIQUE (guild_id, worker_id)
);
INSERT INTO relay_teams_current(id,guild_id,group_id,channel_id,worker_id)
  SELECT id,guild_id,group_id,channel_id,worker_id FROM relay_teams;
DROP TABLE relay_teams;
ALTER TABLE relay_teams_current RENAME TO relay_teams;
DROP TABLE leader_assignments;
DROP TABLE leader_audit;
