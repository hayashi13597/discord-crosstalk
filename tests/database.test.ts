import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { CommitUncertainError, InstanceLease, PostgresLeaders } from '../src/database.js';

afterEach(() => vi.useRealTimers());

describe('database connection failure boundaries', () => {
  it('distinguishes an unconfirmed commit from a failed pre-commit write', async () => {
    for (const failing of ['INSERT INTO leader_audit', 'COMMIT']) {
      const query = vi.fn(async (sql: string) => {
        if (sql.startsWith(failing)) throw new Error('connection reset');
        return { rows: [], rowCount: 0 };
      });
      const release = vi.fn();
      const pool = { connect: async () => ({ query, release }) } as unknown as pg.Pool;
      const result = new PostgresLeaders(pool, 'guild').change(1, 'alice', 'admin');
      if (failing === 'COMMIT') await expect(result).rejects.toBeInstanceOf(CommitUncertainError);
      else await expect(result).rejects.not.toBeInstanceOf(CommitUncertainError);
      expect(query).toHaveBeenCalledWith('ROLLBACK');
      expect(release).toHaveBeenCalledOnce();
    }
  });
  it('releases a connection acquired after shutdown without taking a lease', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const query = vi.fn();
    const release = vi.fn();
    const pool = { connect: () => new Promise(resolve => { finish = resolve; }) } as unknown as pg.Pool;
    const lease = new InstanceLease(pool, 'guild', vi.fn());
    const acquiring = lease.acquire();
    await lease.release();
    finish({ query, release });
    await expect(acquiring).rejects.toThrow('canceled');
    expect(query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports lease loss and explicitly unlocks before closing the connection', async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => ({ rows: [{ locked: true }] }));
    const release = vi.fn();
    const client = Object.assign(new EventEmitter(), { query, release });
    const pool = { connect: async () => client } as unknown as pg.Pool;
    const lost = vi.fn();
    const lease = new InstanceLease(pool, 'guild', lost);
    await lease.acquire();
    client.emit('error', new Error('lease connection lost'));
    expect(lost).toHaveBeenCalledOnce();
    await lease.release();
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('pg_advisory_unlock'), ['crosstalk:instance:guild']);
    expect(release).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('relay topology transaction boundaries', () => {
  it('distinguishes an uncertain COMMIT from an audit write failure', async () => {
    const { PostgresRelays } = await import('../src/relay-repository.js');
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig({
      GUILD_ID: '123456789012345678', LEADER_ROLE_ID: '123456789012345680', BOT_TOKEN_1: 'a', BOT_TOKEN_2: 'b', BOT_TOKEN_3: 'c',
      VOICE_CHANNEL_ID_1: '123456789012345671', VOICE_CHANNEL_ID_2: '123456789012345672', VOICE_CHANNEL_ID_3: '123456789012345673',
      DATABASE_URL: 'postgresql://localhost/test',
    });
    for (const failing of ['INSERT INTO relay_audit', 'COMMIT']) {
      const query = vi.fn(async (sql: string) => {
        if (sql.startsWith(failing)) throw new Error('connection reset');
        return { rows: [], rowCount: 0 };
      });
      const release = vi.fn();
      const pool = { connect: async () => ({ query, release }) } as unknown as pg.Pool;
      const operation = new PostgresRelays(pool, config).mutate({ kind: 'group.create', name: 'Bravo' }, 'admin');
      if (failing === 'COMMIT') await expect(operation).rejects.toBeInstanceOf(CommitUncertainError);
      else await expect(operation).rejects.not.toBeInstanceOf(CommitUncertainError);
      expect(query).toHaveBeenCalledWith('ROLLBACK');
      expect(release).toHaveBeenCalledOnce();
    }
  });
});
