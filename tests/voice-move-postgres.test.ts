import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '../src/database.js';
import { PostgresVoiceMoves } from '../src/voice-move-repository.js';
import { moveCounts } from '../src/voice-move-types.js';
import { moveInput } from './voice-move-helpers.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('mass move persistence on real PostgreSQL', () => {
  const schema = `test_moves_${randomBytes(6).toString('hex')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let repository: PostgresVoiceMoves;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 5 });
    await migrate(pool); await migrate(pool);
    repository = new PostgresVoiceMoves(pool);
  });
  beforeEach(async () => { await pool.query('TRUNCATE voice_move_members,voice_move_jobs'); });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  it('atomically enforces one running job per guild across independent repositories', async () => {
    const inputs = [moveInput(), moveInput()];
    const results = await Promise.allSettled(inputs.map(input => new PostgresVoiceMoves(pool).create(input)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { message: expect.stringContaining('đang có') } });
    expect((await pool.query('SELECT count(*)::int AS n FROM voice_move_members')).rows[0].n).toBe(3);
  });
  it('persists each outcome, excludes foreign guild lookups, and frees the guild after completion', async () => {
    const input = moveInput();
    await repository.create(input);
    for (const [index, member] of input.members.entries()) {
      await repository.processing(input.id, member.userId);
      await repository.outcome(input.id, member.userId, index === 0 ? 'moved' : index === 1 ? 'skipped' : 'failed', index ? 'test_reason' : null);
    }
    await repository.finish(input.id);
    const job = (await new PostgresVoiceMoves(pool).get(input.id, 'guild'))!;
    expect(job.status).toBe('Partially Completed');
    expect(moveCounts(job)).toEqual({ total: 3, moved: 1, skipped: 1, failed: 1, pending: 0 });
    expect(job.sources).toEqual(input.sources);
    expect(job.actorId).toBe(input.actorId);
    expect(job.snapshotAt).toBe(input.snapshotAt);
    expect(await repository.get(input.id, 'foreign')).toBeUndefined();
    await repository.create(moveInput());
  });
  it('rolls back the job if member insertion fails', async () => {
    const input = moveInput();
    input.members.push(input.members[0]!);
    await expect(repository.create(input)).rejects.toThrow();
    expect(await repository.get(input.id, 'guild')).toBeUndefined();
  });
  it('recovers only running jobs as Interrupted, preserving known results and recording uncertainty', async () => {
    const input = moveInput();
    await repository.create(input);
    await repository.processing(input.id, 'user0');
    await repository.outcome(input.id, 'user0', 'moved', null);
    await repository.processing(input.id, 'user1');
    await repository.recover('foreign');
    expect((await repository.get(input.id, 'guild'))!.status).toBe('Running');
    await repository.recover('guild'); await repository.recover('guild');
    const job = (await repository.get(input.id, 'guild'))!;
    expect(job.status).toBe('Interrupted');
    expect(job.members.map(member => member.status)).toEqual(['moved', 'unknown', 'failed']);
    expect(job.members[1]!.reason).toBe('outcome_unknown');
    expect(moveCounts(job).pending).toBe(0);
    await expect(repository.processing(input.id, 'user2')).rejects.toThrow();
    await repository.create(moveInput());
  });
  it('does not complete pending work or overwrite an already recorded outcome', async () => {
    const input = moveInput(1);
    await repository.create(input);
    await expect(repository.finish(input.id)).rejects.toThrow('pending');
    await repository.processing(input.id, 'user0');
    await repository.outcome(input.id, 'user0', 'skipped', 'left_sources');
    await expect(repository.outcome(input.id, 'user0', 'moved', null)).rejects.toThrow();
    await repository.finish(input.id);
    expect((await repository.get(input.id, 'guild'))!.status).toBe('Completed');
  });
  it('audits cancellation and prunes only terminal jobs older than 90 days in this guild', async () => {
    const old = moveInput(); const fresh = moveInput(); const running = moveInput(); const foreign = { ...moveInput(), guildId: 'foreign' };
    await repository.create(old, 'session_expired'); await repository.create(fresh, 'user_cancelled');
    await repository.create(running); await repository.create(foreign, 'user_cancelled');
    await pool.query("UPDATE voice_move_jobs SET finished_at=now()-interval '91 days' WHERE id=ANY($1::uuid[])", [[old.id, foreign.id]]);
    await repository.prune('guild');
    expect(await repository.get(old.id, 'guild')).toBeUndefined();
    expect((await repository.get(fresh.id, 'guild'))!.status).toBe('Cancelled');
    expect((await repository.get(running.id, 'guild'))!.status).toBe('Running');
    expect((await repository.get(foreign.id, 'foreign'))!.status).toBe('Cancelled');
    expect((await pool.query('SELECT count(*)::int AS n FROM voice_move_members WHERE job_id=$1', [old.id])).rows[0].n).toBe(0);
  });
});
