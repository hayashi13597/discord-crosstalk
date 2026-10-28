import type { LocalDatabase } from './sqlite.js';
import { UserError } from './types.js';
import type { MoveInput, MoveJob, VoiceMoveRepository, VoiceMoveSettings, MoveMember, MoveVerification } from './voice-move-types.js';

export class SqliteVoiceMoves implements VoiceMoveRepository {
  constructor(private pool: LocalDatabase) {}

  async getSettings(guildId: string): Promise<VoiceMoveSettings> {
    const result = await this.pool.query('SELECT source_ids,destination_id FROM voice_move_settings WHERE guild_id=$1', [guildId]);
    const row = result.rows[0];
    return { sourceIds: row ? JSON.parse(row.source_ids) : [], destinationId: row?.destination_id ?? null };
  }

  async getDestination(guildId: string): Promise<string | null> {
    return (await this.getSettings(guildId)).destinationId;
  }

  async setSources(guildId: string, sourceIds: string[]): Promise<void> {
    await this.pool.query(`INSERT INTO voice_move_settings(guild_id,source_ids) VALUES($1,$2)
      ON CONFLICT(guild_id) DO UPDATE SET source_ids=excluded.source_ids`, [guildId, JSON.stringify(sourceIds)]);
  }

  async setDestination(guildId: string, destinationId: string): Promise<void> {
    await this.pool.query(`INSERT INTO voice_move_settings(guild_id,destination_id) VALUES($1,$2)
      ON CONFLICT(guild_id) DO UPDATE SET destination_id=excluded.destination_id`, [guildId, destinationId]);
  }

  async create(input: MoveInput, cancelledReason?: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO voice_move_jobs
        (id,guild_id,actor_id,sources,destination_id,snapshot_at,bots_skipped,status,reason,finished_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $8 = 'Cancelled' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') END)`,
      [input.id, input.guildId, input.actorId, JSON.stringify(input.sources), input.destinationId,
        input.snapshotAt === null ? null : new Date(input.snapshotAt).toISOString(), input.botsSkipped,
        cancelledReason ? 'Cancelled' : 'Running', cancelledReason ?? null]);
      for (const [ordinal, member] of input.members.entries()) {
        await client.query(`INSERT INTO voice_move_members(job_id,user_id,source_id,ordinal,status,reason)
          VALUES($1,$2,$3,$4,$5,$6)`, [input.id, member.userId, member.sourceId, ordinal + 1,
          cancelledReason ? 'skipped' : 'pending', cancelledReason ?? null]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed: voice_move_jobs.guild_id')) {
        throw new UserError('Guild đang có một tác vụ Mass Voice Move thực thi. Hãy đợi tác vụ đó kết thúc.');
      }
      // An uncertain COMMIT never authorizes a Discord request. Startup recovery handles it.
      throw error;
    } finally { client.release(); }
  }

  async enqueue(id: string, members: MoveMember[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const running = await client.query("SELECT id FROM voice_move_jobs WHERE id=$1 AND status='Running'", [id]);
      if (!running.rowCount) throw new Error('Voice move is no longer running');
      for (const member of members) {
        await client.query(`INSERT INTO voice_move_members(job_id,user_id,source_id,ordinal,status)
          VALUES($1,$2,$3,(SELECT COALESCE(MAX(ordinal),0)+1 FROM voice_move_members WHERE job_id=$1),'pending')
          ON CONFLICT(job_id,user_id) DO UPDATE SET source_id=excluded.source_id,status='pending',reason=NULL,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE voice_move_members.status != 'processing'`,
        [id, member.userId, member.sourceId]);
      }
      // A previous scan no longer describes the job after another attempt is queued.
      await client.query('UPDATE voice_move_jobs SET verification=NULL WHERE id=$1', [id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async verify(id: string, verification: MoveVerification): Promise<void> {
    const result = await this.pool.query(`UPDATE voice_move_jobs SET verification=$2 WHERE id=$1 AND status='Running'`,
      [id, JSON.stringify(verification)]);
    if (result.rowCount !== 1) throw new Error('Voice move is no longer running');
  }

  async processing(id: string, userId: string): Promise<void> {
    const result = await this.pool.query(`UPDATE voice_move_members SET status='processing',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE job_id=$1 AND user_id=$2 AND status='pending'
      AND EXISTS (SELECT 1 FROM voice_move_jobs WHERE id=$1 AND status='Running')`, [id, userId]);
    if (result.rowCount !== 1) throw new Error('Voice move is no longer pending');
  }

  async outcome(id: string, userId: string, status: 'moved' | 'skipped' | 'failed' | 'unknown', reason: string | null): Promise<void> {
    const result = await this.pool.query(`UPDATE voice_move_members SET status=$3,reason=$4,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE job_id=$1 AND user_id=$2
      AND EXISTS (SELECT 1 FROM voice_move_jobs WHERE id=$1 AND status='Running')`, [id, userId, status, reason]);
    if (result.rowCount !== 1) throw new Error('Voice move outcome could not be persisted');
  }

  async finish(id: string, interruptedReason?: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM voice_move_jobs WHERE id=$1', [id]);
      if (interruptedReason) await client.query(`UPDATE voice_move_members SET
        status=CASE WHEN status='processing' THEN 'unknown' ELSE 'failed' END,
        reason=CASE WHEN status='processing' THEN 'outcome_unknown' ELSE $2 END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE job_id=$1 AND status IN ('pending','processing')`, [id, interruptedReason]);
      const updated = await client.query(`UPDATE voice_move_jobs SET status=CASE
          WHEN $2 IS NOT NULL THEN 'Interrupted'
          WHEN EXISTS (SELECT 1 FROM voice_move_members WHERE job_id=$1 AND status IN ('failed','unknown'))
            THEN CASE WHEN EXISTS (SELECT 1 FROM voice_move_members WHERE job_id=$1 AND status='moved') THEN 'Partially Completed' ELSE 'Failed' END
          ELSE 'Completed' END,
        reason=$2,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=$1 AND status='Running'
        AND NOT EXISTS (SELECT 1 FROM voice_move_members WHERE job_id=$1 AND status IN ('pending','processing'))`, [id, interruptedReason ?? null]);
      if (updated.rowCount !== 1) throw new Error('Voice move still has pending members or is already closed');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async get(id: string, guildId: string): Promise<MoveJob | undefined> {
    const client = await this.pool.connect();
    try {
      const row = (await client.query('SELECT * FROM voice_move_jobs WHERE id=$1 AND guild_id=$2', [id, guildId])).rows[0];
      if (!row) return undefined;
      const members = (await client.query(`SELECT user_id AS "userId", source_id AS "sourceId", status, reason
        FROM voice_move_members WHERE job_id=$1 ORDER BY ordinal`, [id])).rows;
      return { id: row.id, guildId: row.guild_id, actorId: row.actor_id, sources: JSON.parse(row.sources),
        verification: row.verification ? JSON.parse(row.verification) : null,
        destinationId: row.destination_id, snapshotAt: row.snapshot_at ? Date.parse(row.snapshot_at) : null,
        botsSkipped: row.bots_skipped, status: row.status, reason: row.reason,
        createdAt: row.created_at, finishedAt: row.finished_at, members };
    } finally { client.release(); }
  }

  async recover(guildId: string): Promise<void> {
    // Called only after acquiring the existing process lease for this guild.
    const jobs = await this.pool.query("SELECT id FROM voice_move_jobs WHERE guild_id=$1 AND status='Running'", [guildId]);
    for (const job of jobs.rows) await this.finish(job.id, 'service_restarted');
  }

  async prune(guildId: string): Promise<void> {
    await this.pool.query("DELETE FROM voice_move_jobs WHERE guild_id=$1 AND finished_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')", [guildId]);
  }
}
