import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { InstanceLease, migrate, PostgresLeaders } from '../src/database.js';
import { emptyLeaders } from '../src/types.js';

// Use a dedicated test DB. Each run creates and drops its own isolated schema.
describe.skipIf(!process.env.TEST_DATABASE_URL)('real PostgreSQL transactions', () => {
  const schema = `test_crosstalk_${randomBytes(6).toString('hex')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let repository: PostgresLeaders;
  const guild = '123456789012345678';
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 5 });
    await migrate(pool);
    await migrate(pool);
    repository = new PostgresLeaders(pool, guild);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  it('initializes empty, replaces, audits and survives a new repository instance', async () => {
    expect(await repository.load()).toEqual(emptyLeaders());
    await repository.change(1, 'alice', 'admin');
    await repository.change(1, 'bob', 'admin');
    expect(await new PostgresLeaders(pool, guild).load()).toEqual({ 1: 'bob', 2: null, 3: null });
    const result = await pool.query('SELECT old_user_id, new_user_id, actor_id FROM leader_audit ORDER BY id');
    expect(result.rows).toEqual([
      { old_user_id: null, new_user_id: 'alice', actor_id: 'admin' },
      { old_user_id: 'alice', new_user_id: 'bob', actor_id: 'admin' },
    ]);
  });
  it('rejects duplicate assignment and does not audit rejected/idempotent operations', async () => {
    await expect(repository.change(2, 'bob', 'admin')).rejects.toThrow('team khác');
    await repository.change(1, 'bob', 'admin');
    const result = await pool.query('SELECT count(*)::int AS count FROM leader_audit');
    expect(result.rows[0].count).toBe(2);
  });
  it('rolls back assignment if writing the audit fails', async () => {
    await pool.query("ALTER TABLE leader_audit ADD CONSTRAINT reject_test_actor CHECK (actor_id <> 'reject')");
    await expect(repository.change(1, 'carol', 'reject')).rejects.toThrow();
    expect((await repository.load())[1]).toBe('bob');
    await pool.query('ALTER TABLE leader_audit DROP CONSTRAINT reject_test_actor');
  });
  it('serializes concurrent assignment of one user to two teams', async () => {
    const results = await Promise.allSettled([repository.change(2, 'carol', 'admin'), repository.change(3, 'carol', 'admin')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(Object.values(await repository.load()).filter(id => id === 'carol')).toHaveLength(1);
    await repository.change(2, null, 'admin');
    await repository.change(3, null, 'admin');
  });
  it('persists removal', async () => {
    await repository.change(1, null, 'admin');
    expect(await new PostgresLeaders(pool, guild).load()).toEqual(emptyLeaders());
  });
  it('allows only one process lease per guild and releases it on shutdown', async () => {
    const lease1 = new InstanceLease(pool, guild, () => {});
    const lease2 = new InstanceLease(pool, guild, () => {});
    try {
      await lease1.acquire();
      await expect(lease2.acquire()).rejects.toThrow('Another CrossTalk');
    } finally { await lease1.release(); await lease2.release(); }
    const lease3 = new InstanceLease(pool, guild, () => {});
    try { await lease3.acquire(); } finally { await lease3.release(); }
  });
});
