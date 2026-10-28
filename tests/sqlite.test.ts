import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, mkdir, utimes, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalDatabase, LocalInstanceLease } from '../src/sqlite.js';
import { SqliteRelays } from '../src/sqlite-relays.js';
import { SqliteVoiceMoves } from '../src/sqlite-voice-moves.js';
import { loadConfig } from '../src/config.js';
import type { MoveInput } from '../src/voice-move-types.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'crosstalk-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const db = new LocalDatabase(join(directory, 'bot.sqlite'));
  cleanup.push(() => db.end());
  await db.migrate();
  const config = loadConfig({ GUILD_ID: '123456789012345678', LEADER_ROLE_ID: '123456789012345680', BOT_TOKEN_1: 'one', BOT_TOKEN_2: 'two', BOT_TOKEN_3: 'three' });
  return { db, directory, config, relays: new SqliteRelays(db, config), moves: new SqliteVoiceMoves(db) };
}
it('migrates idempotently and persists command-configured channels with workers 1–3', async () => {
  const { db, relays } = await setup();
  await db.migrate();
  const initial = await relays.initialize();
  expect(initial.groups).toEqual([expect.objectContaining({ name: 'Group A', state: 'active', legacy: true })]);
  expect(initial.teams).toEqual([]);
  const groupId = initial.groups[0]!.id;
  const next = await relays.mutate({ kind: 'team.add', groupId, channelId: 'channel-one' }, 'actor');
  expect(next.teams[0]!.workerId).toBe(1);
  expect((await relays.initialize()).teams).toEqual(next.teams);
  await relays.identify(1, 'bot-user');
  await expect(relays.identify(1, 'different-user')).rejects.toThrow('identity');
  await expect(relays.mutate({ kind: 'team.add', groupId, channelId: 'channel-one' }, 'actor')).rejects.toThrow('đã được gán');
  expect((await relays.initialize()).teams).toHaveLength(1);
  expect((await db.query('SELECT * FROM relay_audit')).rows).toHaveLength(2);
});
it('serializes transactions and rolls back failed writes', async () => {
  const { db } = await setup();
  const client = await db.connect();
  await client.query('BEGIN');
  await client.query("INSERT INTO relay_guilds(guild_id) VALUES('temporary')");
  let completed = false;
  const queued = db.query('SELECT * FROM relay_guilds').then(result => { completed = true; return result; });
  await Promise.resolve();
  expect(completed).toBe(false);
  await client.query('ROLLBACK');
  client.release();
  expect((await queued).rows).toEqual([]);
});
const input: MoveInput = { id: 'job-one', guildId: 'guild', actorId: 'actor', sources: [{ id: 'source', humans: 2, bots: 0 }], destinationId: 'target', snapshotAt: Date.now(), botsSkipped: 0, members: [{ userId: 'user-one', sourceId: 'source' }, { userId: 'user-two', sourceId: 'source' }] };
it('persists moves, excludes competing jobs, recovers interrupted work and prunes history', async () => {
  const { db, moves } = await setup();
  await moves.create(input);
  await expect(moves.create({ ...input, id: 'competing' })).rejects.toThrow('Guild đang có');
  await moves.processing(input.id, 'user-one');
  await moves.recover('guild');
  const job = await moves.get(input.id, 'guild');
  expect(job).toMatchObject({ status: 'Interrupted', sources: input.sources, snapshotAt: input.snapshotAt, members: [{ status: 'unknown' }, { status: 'failed' }] });
  expect(await moves.get(input.id, 'another-guild')).toBeUndefined();
  await db.query("UPDATE voice_move_jobs SET finished_at='2000-01-01T00:00:00.000Z' WHERE id=$1", [input.id]);
  await moves.prune('guild');
  expect(await moves.get(input.id, 'guild')).toBeUndefined();
  expect((await db.query('SELECT * FROM voice_move_members')).rows).toEqual([]);
});
it('finishes successful and cancelled moves with JSON and timestamps intact', async () => {
  const { moves } = await setup();
  await moves.create(input);
  for (const member of input.members) {
    await moves.processing(input.id, member.userId);
    await moves.outcome(input.id, member.userId, 'moved', null);
  }
  await moves.finish(input.id);
  expect(await moves.get(input.id, 'guild')).toMatchObject({ status: 'Completed', finishedAt: expect.any(String) });
  await moves.create({ ...input, id: 'cancelled' }, 'user_cancelled');
  expect(await moves.get('cancelled', 'guild')).toMatchObject({ status: 'Cancelled', members: [{ status: 'skipped' }, { status: 'skipped' }] });
});
it('rejects a second local instance and allows handoff after release', async () => {
  const { db } = await setup();
  const lost = vi.fn();
  const first = new LocalInstanceLease(db, lost);
  const second = new LocalInstanceLease(db, lost);
  await first.acquire();
  cleanup.push(() => first.release());
  await expect(second.acquire()).rejects.toThrow();
  await first.release();
  await second.acquire();
  await second.release();
  expect(lost).not.toHaveBeenCalled();
});

it('reads saved teams after reopening the database file', async () => {
  const { db, directory, config, relays } = await setup();
  const initial = await relays.initialize();
  const saved = await relays.mutate({ kind: 'team.add', groupId: initial.groups[0]!.id, channelId: 'saved-channel' }, 'actor');
  // A separate connection reads committed data, just as a restarted process does.
  const reopened = new LocalDatabase(join(directory, 'bot.sqlite'));
  try {
    await reopened.migrate();
    expect((await new SqliteRelays(reopened, config).initialize()).teams).toEqual(saved.teams);
    expect(await db.query('SELECT 1')).toMatchObject({ rowCount: 1 });
  } finally { await reopened.end(); }
});
it('reclaims an expired lock left by a crashed process', async () => {
  const { db } = await setup();
  const lockPath = `${db.path}.lock`;
  await mkdir(lockPath);
  const expired = new Date(Date.now() - 60000);
  await utimes(lockPath, expired, expired);
  const lease = new LocalInstanceLease(db, vi.fn());
  await lease.acquire();
  await lease.release();
});

it('upgrades the previous SQLite schema without losing channel mappings or move history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crosstalk-upgrade-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'bot.sqlite');
  const previous = new DatabaseSync(path);
  try {
    previous.exec(await readFile(new URL('../migrations/001_sqlite.sql', import.meta.url), 'utf8'));
    previous.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations VALUES(1);
      INSERT INTO relay_guilds(guild_id) VALUES('guild');
      INSERT INTO relay_groups(id,guild_id,name,state,legacy) VALUES('group','guild','Group A','active',true);
      INSERT INTO relay_workers(guild_id,worker_id,user_id) VALUES('guild',1,'verified-bot');
      INSERT INTO relay_teams(id,guild_id,group_id,channel_id,worker_id) VALUES('team','guild','group','saved-channel',1);
      INSERT INTO relay_audit(guild_id,actor_id,action,details) VALUES('guild','actor','team.add','{}');`);
  } finally { previous.close(); }
  const db = new LocalDatabase(path);
  cleanup.push(() => db.end());
  const moves = new SqliteVoiceMoves(db);
  await moves.create(input);
  await moves.processing(input.id, 'user-one');
  await moves.outcome(input.id, 'user-one', 'moved', null);
  const savedJob = await moves.get(input.id, 'guild');
  await db.migrate();
  await db.migrate();
  expect((await db.query('SELECT * FROM relay_teams')).rows).toEqual([
    { id: 'team', guild_id: 'guild', group_id: 'group', channel_id: 'saved-channel', worker_id: 1 },
  ]);
  expect((await db.query('SELECT * FROM relay_workers')).rows[0]).toMatchObject({ user_id: 'verified-bot' });
  expect((await db.query('SELECT * FROM relay_audit')).rows).toHaveLength(1);
  expect(await moves.get(input.id, 'guild')).toEqual(savedJob);
  expect((await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('leader_assignments','leader_audit')")).rows).toEqual([]);
  expect((await db.query('PRAGMA foreign_key_check')).rows).toEqual([]);
  expect((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows).toEqual([{ version: 1 }, { version: 2 }]);
});
