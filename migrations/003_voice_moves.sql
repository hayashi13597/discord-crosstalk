CREATE TABLE voice_move_jobs (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL,
  actor_id text NOT NULL,
  sources jsonb NOT NULL,
  destination_id text,
  snapshot_at timestamptz,
  bots_skipped integer NOT NULL DEFAULT 0 CHECK (bots_skipped >= 0),
  status text NOT NULL CHECK (status IN ('Running', 'Completed', 'Partially Completed', 'Cancelled', 'Failed', 'Interrupted')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX voice_move_one_running ON voice_move_jobs (guild_id) WHERE status = 'Running';
CREATE INDEX voice_move_retention ON voice_move_jobs (guild_id, finished_at);
CREATE TABLE voice_move_members (
  job_id uuid NOT NULL REFERENCES voice_move_jobs(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  source_id text NOT NULL,
  ordinal integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'moved', 'skipped', 'failed', 'unknown')),
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, user_id),
  UNIQUE (job_id, ordinal)
);
