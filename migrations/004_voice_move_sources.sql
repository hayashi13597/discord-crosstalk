CREATE TABLE voice_move_settings_current (
  guild_id text PRIMARY KEY,
  destination_id text,
  source_ids text NOT NULL DEFAULT '[]'
);
INSERT INTO voice_move_settings_current(guild_id,destination_id)
  SELECT guild_id,destination_id FROM voice_move_settings;
DROP TABLE voice_move_settings;
ALTER TABLE voice_move_settings_current RENAME TO voice_move_settings;
