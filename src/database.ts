import { readFile } from 'node:fs/promises';
import pg, { type PoolClient, type QueryResultRow } from 'pg';
import { emptyLeaders, UserError, type Leaders, type Team } from './types.js';

export interface LeaderRepository {
  load(): Promise<Leaders>;
  change(team: Team, userId: string | null, actorId: string): Promise<Leaders>;
  healthy(): Promise<boolean>;
}

export class CommitUncertainError extends Error {
  constructor(cause: unknown) { super('Could not confirm leader transaction commit', { cause }); }
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('crosstalk:migrations', 0))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const [version, filename] of [[1, '001_initial.sql'], [2, '002_relay_groups.sql']] as const) {
      const existing = await client.query('SELECT version FROM schema_migrations WHERE version = $1', [version]);
      if (!existing.rowCount) {
        const sql = await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, query_timeout: 5000,
    statement_timeout: 5000, idle_in_transaction_session_timeout: 10000 });
}

interface Assignment extends QueryResultRow { team_id: Team; user_id: string }
function snapshot(rows: Assignment[]): Leaders {
  const result = emptyLeaders();
  for (const row of rows) result[row.team_id] = row.user_id;
  return result;
}

export class PostgresLeaders implements LeaderRepository {
  constructor(readonly pool: pg.Pool, readonly guildId: string) {}
  async load(): Promise<Leaders> {
    const result = await this.pool.query<Assignment>('SELECT team_id, user_id FROM leader_assignments WHERE guild_id = $1', [this.guildId]);
    return snapshot(result.rows);
  }
  async healthy(): Promise<boolean> {
    try { await this.pool.query('SELECT 1'); return true; } catch { return false; }
  }
  async change(team: Team, userId: string | null, actorId: string): Promise<Leaders> {
    const client = await this.pool.connect();
    let committing = false;
    try {
      await client.query('BEGIN');
      // Serialize even when no assignment rows exist yet.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`crosstalk:leaders:${this.guildId}`]);
      const rows = await client.query<Assignment>('SELECT team_id, user_id FROM leader_assignments WHERE guild_id = $1 FOR UPDATE', [this.guildId]);
      const leaders = snapshot(rows.rows);
      if (userId && rows.rows.some(row => row.user_id === userId && row.team_id !== team)) {
        throw new UserError('Người này đã là leader của team khác. Hãy gỡ phân công cũ trước.');
      }
      const oldId = leaders[team];
      if (oldId !== userId) {
        if (userId) {
          await client.query(`INSERT INTO leader_assignments(guild_id, team_id, user_id) VALUES ($1,$2,$3)
            ON CONFLICT (guild_id, team_id) DO UPDATE SET user_id = EXCLUDED.user_id, updated_at = now()`, [this.guildId, team, userId]);
        } else {
          await client.query('DELETE FROM leader_assignments WHERE guild_id = $1 AND team_id = $2', [this.guildId, team]);
        }
        await client.query('INSERT INTO leader_audit(guild_id, team_id, old_user_id, new_user_id, actor_id) VALUES ($1,$2,$3,$4,$5)',
          [this.guildId, team, oldId, userId, actorId]);
        leaders[team] = userId;
      }
      committing = true;
      await client.query('COMMIT');
      committing = false;
      return leaders;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (committing) throw new CommitUncertainError(error);
      throw error;
    } finally { client.release(); }
  }
}

export class InstanceLease {
  private client?: PoolClient;
  private heartbeat?: NodeJS.Timeout;
  private checking = false;
  private closing = false;
  constructor(private pool: pg.Pool, private guildId: string, private onLost: (error: unknown) => void) {}

  async acquire(): Promise<void> {
    const client = await this.pool.connect();
    if (this.closing) { client.release(true); throw new Error('Instance lease acquisition canceled'); }
    this.client = client;
    client.on('error', error => { if (!this.closing) this.onLost(error); });
    const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`crosstalk:instance:${this.guildId}`]);
    if (this.closing) throw new Error('Instance lease acquisition canceled');
    if (!result.rows[0]?.locked) throw new Error('Another CrossTalk instance already controls this guild');
    this.heartbeat = setInterval(() => {
      if (this.checking || this.closing) return;
      this.checking = true;
      void client.query('SELECT 1').catch(error => { if (!this.closing) this.onLost(error); })
        .finally(() => { this.checking = false; });
    }, 5000);
  }

  async release(): Promise<void> {
    this.closing = true;
    clearInterval(this.heartbeat);
    // Explicit unlock makes a successful handoff observable before this Promise resolves.
    // Closing the physical connection also covers failed unlocks and partial startup.
    if (this.client) {
      await this.client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`crosstalk:instance:${this.guildId}`]).catch(() => {});
      this.client.release(true);
    }
    this.client = undefined;
  }
}
