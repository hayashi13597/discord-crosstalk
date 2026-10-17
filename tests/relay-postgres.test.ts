import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate, PostgresLeaders } from '../src/database.js';
import { loadConfig } from '../src/config.js';
import { PostgresRelays } from '../src/relay-repository.js';
import { targetVersion, type RelayMutation, type RelaySnapshot } from '../src/types.js';

const config = loadConfig({
  GUILD_ID: '123456789012345678', BOT_TOKEN_1: 'a', BOT_TOKEN_2: 'b', BOT_TOKEN_3: 'c', BOT_TOKEN_4: 'd', BOT_TOKEN_5: 'e', BOT_TOKEN_6: 'f',
  VOICE_CHANNEL_ID_1: '123456789012345671', VOICE_CHANNEL_ID_2: '123456789012345672', VOICE_CHANNEL_ID_3: '123456789012345673',
  DATABASE_URL: 'postgresql://localhost/test',
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('relay groups on real PostgreSQL', () => {
  const schema = `test_relays_${randomBytes(6).toString('hex')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let repository: PostgresRelays;
  let initial: RelaySnapshot;
  const change = (action: RelayMutation) => repository.mutate(action, 'admin');
  const bravo = async () => (await change({ kind: 'group.create', name: 'Bravo' })).groups.find(group => !group.legacy)!;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 5 });
    // Start from exactly the old schema, then apply only the pending migration twice.
    await pool.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
    await pool.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    await pool.query('INSERT INTO schema_migrations(version) VALUES (1)');
    await migrate(pool);
    await migrate(pool);
    repository = new PostgresRelays(pool, config);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE relay_audit, relay_teams, relay_workers, relay_groups, relay_guilds, leader_audit, leader_assignments');
    await pool.query('INSERT INTO leader_assignments(guild_id,team_id,user_id) VALUES ($1,1,\'alice\'),($1,2,\'bob\')', [config.guildId]);
    initial = await repository.initialize();
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it('imports all old assignments without modifying the legacy tables', async () => {
    expect(initial.groups).toEqual([{ id: expect.any(String), name: 'Group A', state: 'active', legacy: true }]);
    expect(initial.teams.map(team => [team.legacySlot, team.workerId, team.channelId, team.leaderId])).toEqual([
      [1, 1, config.bots[1].channelId, 'alice'], [2, 2, config.bots[2].channelId, 'bob'], [3, 3, config.bots[3].channelId, null],
    ]);
    expect(await new PostgresLeaders(pool, config.guildId).load()).toEqual({ 1: 'alice', 2: 'bob', 3: null });
    expect((await pool.query('SELECT count(*)::int AS count FROM leader_audit')).rows[0].count).toBe(0);
    expect((await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows).toEqual([{ version: 1 }, { version: 2 }]);
  });
  it('rolls back a failed first import without modifying legacy data or leaving a bootstrap marker', async () => {
    await pool.query('TRUNCATE relay_audit, relay_teams, relay_workers, relay_groups, relay_guilds');
    await pool.query("ALTER TABLE relay_audit ADD CONSTRAINT reject_import CHECK (actor_id <> 'system')");
    try {
      await expect(repository.initialize()).rejects.toThrow();
      expect((await pool.query('SELECT count(*)::int AS count FROM relay_guilds')).rows[0].count).toBe(0);
      expect((await new PostgresLeaders(pool, config.guildId).load())[1]).toBe('alice');
    } finally { await pool.query('ALTER TABLE relay_audit DROP CONSTRAINT reject_import'); }
    expect((await repository.initialize()).teams).toHaveLength(3);
  });
  it('restores stable mappings and group state despite changed bootstrap variables', async () => {
    await change({ kind: 'group.state', groupId: initial.groups[0]!.id, state: 'paused' });
    const changed = structuredClone(config);
    changed.bots[1].channelId = 'different-env-channel';
    const restored = await new PostgresRelays(pool, changed).initialize();
    expect(restored.teams).toEqual(initial.teams);
    expect(restored.groups[0]!.state).toBe('paused');
  });
  it('creates a paused group and reserves distinct workers 4–6 even before resume', async () => {
    const group = await bravo();
    expect(group.state).toBe('paused');
    await Promise.all([1, 2, 3].map(index => change({ kind: 'team.add', groupId: group.id, channelId: `b${index}` })));
    const state = await repository.initialize();
    expect(state.teams.filter(team => team.groupId === group.id).map(team => team.workerId)).toEqual([4, 5, 6]);
    expect(state.teams.filter(team => team.groupId !== group.id)).toEqual(initial.teams);
    await expect(change({ kind: 'team.add', groupId: group.id, channelId: 'b4' })).rejects.toThrow('Không còn bot account');
    expect(await new PostgresRelays(pool, config).initialize()).toEqual(state);
  });
  it('serializes concurrent attempts to assign the same channel', async () => {
    const group = await bravo();
    const results = await Promise.allSettled([1, 2].map(() => change({ kind: 'team.add', groupId: group.id, channelId: 'duplicate' })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await repository.initialize()).teams.filter(team => team.channelId === 'duplicate')).toHaveLength(1);
    await expect(change({ kind: 'team.add', groupId: group.id, channelId: config.bots[1].channelId })).rejects.toThrow('đã được gán');
  });
  it('enforces names and leader uniqueness across groups', async () => {
    const group = await bravo();
    await expect(change({ kind: 'group.create', name: ' bravo ' })).rejects.toThrow('đã được sử dụng');
    await expect(change({ kind: 'group.create', name: 'bad\nname' })).rejects.toThrow('ký tự');
    const state = await change({ kind: 'team.add', groupId: group.id, channelId: 'b1' });
    const team = state.teams.find(team => team.groupId === group.id)!;
    await expect(change({ kind: 'leader.change', teamId: team.id, userId: 'alice' })).rejects.toThrow('team khác');
    await change({ kind: 'leader.change', teamId: team.id, userId: 'bravo-leader' });
    expect((await repository.initialize()).teams.filter(team => team.legacySlot)).toEqual(initial.teams);
  });
  it('mirrors changes/removals into legacy assignments and audit for rollback', async () => {
    const team = initial.teams[0]!;
    await change({ kind: 'leader.change', teamId: team.id, userId: 'new-alice' });
    const old = new PostgresLeaders(pool, config.guildId);
    expect((await old.load())[1]).toBe('new-alice');
    await change({ kind: 'leader.change', teamId: team.id, userId: null });
    expect((await old.load())[1]).toBeNull();
    const audit = await pool.query('SELECT old_user_id,new_user_id FROM leader_audit ORDER BY id');
    expect(audit.rows).toEqual([{ old_user_id: 'alice', new_user_id: 'new-alice' }, { old_user_id: 'new-alice', new_user_id: null }]);
  });
  it('rolls back both schemas when writing the new audit fails', async () => {
    await pool.query("ALTER TABLE relay_audit ADD CONSTRAINT reject_actor CHECK (actor_id <> 'reject')");
    try {
      await expect(repository.mutate({ kind: 'leader.change', teamId: initial.teams[0]!.id, userId: 'new-alice' }, 'reject')).rejects.toThrow();
      expect(await repository.initialize()).toEqual(initial);
      expect((await new PostgresLeaders(pool, config.guildId).load())[1]).toBe('alice');
      expect((await pool.query('SELECT count(*)::int AS count FROM leader_audit')).rows[0].count).toBe(0);
    } finally { await pool.query('ALTER TABLE relay_audit DROP CONSTRAINT reject_actor'); }
  });
  it('rejects stale confirmations and protects Group A', async () => {
    const group = await bravo();
    const state = await change({ kind: 'team.add', groupId: group.id, channelId: 'b1' });
    const expected = targetVersion(state, 'group', group.id);
    await change({ kind: 'group.state', groupId: group.id, state: 'active' });
    await expect(change({ kind: 'group.delete', groupId: group.id, expected })).rejects.toThrow('đã thay đổi');
    await expect(change({ kind: 'group.delete', groupId: initial.groups[0]!.id, expected: targetVersion(initial, 'group', initial.groups[0]!.id) })).rejects.toThrow('Không được xóa Group A');
    const current = await repository.initialize();
    await change({ kind: 'group.delete', groupId: group.id, expected: targetVersion(current, 'group', group.id) });
    expect((await repository.initialize()).teams).toEqual(initial.teams);
    const next = await bravo();
    expect((await change({ kind: 'team.add', groupId: next.id, channelId: 'b1' })).teams.find(team => team.groupId === next.id)!.workerId).toBe(4);
  });
  it('does not recreate removed legacy teams or reassign their worker slots', async () => {
    const team = initial.teams[0]!;
    await change({ kind: 'team.remove', teamId: team.id, expected: targetVersion(initial, 'team', team.id) });
    expect((await repository.initialize()).teams.some(team => team.legacySlot === 1)).toBe(false);
    expect((await new PostgresLeaders(pool, config.guildId).load())[1]).toBeNull();
    const group = await bravo();
    expect((await change({ kind: 'team.add', groupId: group.id, channelId: 'b1' })).teams.find(team => team.groupId === group.id)!.workerId).toBe(4);
  });
  it('rejects duplicate or changed Discord identities while allowing token rotation for the same account', async () => {
    await repository.identify(1, 'discord-bot-1');
    await repository.identify(1, 'discord-bot-1');
    await expect(repository.identify(4, 'discord-bot-1')).rejects.toMatchObject({ code: 'BOT_IDENTITY_CONFLICT' });
    await expect(repository.identify(1, 'replacement-account')).rejects.toMatchObject({ code: 'BOT_IDENTITY_CONFLICT' });
    await repository.identify(4, 'discord-bot-4');
  });
  it('restores unavailable workers without stealing assignments and blocks resume until their token returns', async () => {
    const group = await bravo();
    const state = await change({ kind: 'team.add', groupId: group.id, channelId: 'b1' });
    const limited = new PostgresRelays(pool, { ...config, workers: config.workers.filter(worker => worker.id <= 3) });
    expect(await limited.initialize()).toEqual(state);
    await expect(limited.mutate({ kind: 'group.state', groupId: group.id, state: 'active' }, 'admin')).rejects.toThrow('Thiếu token');
    await expect(limited.mutate({ kind: 'team.add', groupId: group.id, channelId: 'b2' }, 'admin')).rejects.toThrow('Không còn bot account');
    expect((await repository.initialize()).groups.find(item => item.id === group.id)!.state).toBe('paused');
  });
});
