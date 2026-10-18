import type pg from 'pg';
import { UserError } from './types.js';
import type { MoveInput, MoveJob, VoiceMoveRepository } from './voice-move-types.js';

export class PostgresVoiceMoves implements VoiceMoveRepository {
  constructor(private pool: pg.Pool) {}

  async create(input: MoveInput, cancelledReason?: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO voice_move_jobs
        (id,guild_id,actor_id,sources,destination_id,snapshot_at,bots_skipped,status,reason,finished_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $8 = 'Cancelled' THEN now() END)`,
      [input.id, input.guildId, input.actorId, JSON.stringify(input.sources), input.destinationId,
        input.snapshotAt === null ? null : new Date(input.snapshotAt), input.botsSkipped,
        cancelledReason ? 'Cancelled' : 'Running', cancelledReason ?? null]);
      await client.query(`INSERT INTO voice_move_members (job_id,user_id,source_id,ordinal,status,reason)
        SELECT $1, value->>'userId', value->>'sourceId', ordinality::integer,
          CASE WHEN $3::text IS NULL THEN 'pending' ELSE 'skipped' END, $3
        FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY`, [input.id, JSON.stringify(input.members), cancelledReason ?? null]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error && typeof error === 'object' && 'constraint' in error && error.constraint === 'voice_move_one_running') {
        throw new UserError('Guild đang có một tác vụ Mass Voice Move thực thi. Hãy đợi tác vụ đó kết thúc.');
      }
      // An uncertain COMMIT never authorizes a Discord request. Startup recovery handles it.
      throw error;
    } finally { client.release(); }
  }

  async processing(id: string, userId: string): Promise<void> {
    const result = await this.pool.query(`UPDATE voice_move_members SET status='processing',updated_at=now()
      WHERE job_id=$1 AND user_id=$2 AND status='pending'
      AND EXISTS (SELECT 1 FROM voice_move_jobs WHERE id=$1 AND status='Running')`, [id, userId]);
    if (result.rowCount !== 1) throw new Error('Voice move is no longer pending');
  }

  async outcome(id: string, userId: string, status: 'moved' | 'skipped' | 'failed' | 'unknown', reason: string | null): Promise<void> {
    const result = await this.pool.query(`UPDATE voice_move_members SET status=$3,reason=$4,updated_at=now()
      WHERE job_id=$1 AND user_id=$2 AND status='processing'`, [id, userId, status, reason]);
    if (result.rowCount !== 1) throw new Error('Voice move outcome could not be persisted');
  }

  async finish(id: string, interruptedReason?: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM voice_move_jobs WHERE id=$1 FOR UPDATE', [id]);
      if (interruptedReason) await client.query(`UPDATE voice_move_members SET
        status=CASE WHEN status='processing' THEN 'unknown' ELSE 'failed' END,
        reason=CASE WHEN status='processing' THEN 'outcome_unknown' ELSE $2 END,updated_at=now()
        WHERE job_id=$1 AND status IN ('pending','processing')`, [id, interruptedReason]);
      const updated = await client.query(`UPDATE voice_move_jobs SET status=CASE
          WHEN $2::text IS NOT NULL THEN 'Interrupted'
          WHEN EXISTS (SELECT 1 FROM voice_move_members WHERE job_id=$1 AND status IN ('failed','unknown'))
            THEN CASE WHEN EXISTS (SELECT 1 FROM voice_move_members WHERE job_id=$1 AND status='moved') THEN 'Partially Completed' ELSE 'Failed' END
          ELSE 'Completed' END,
        reason=$2,finished_at=now()
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
    // One statement gives a consistent view while the worker is updating outcomes.
    const result = await this.pool.query(`SELECT j.*, COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'userId',m.user_id,'sourceId',m.source_id,'status',m.status,'reason',m.reason) ORDER BY ordinal)
        FROM voice_move_members m WHERE m.job_id=j.id),'[]'::jsonb) AS members
      FROM voice_move_jobs j WHERE j.id=$1 AND j.guild_id=$2`, [id, guildId]);
    const row = result.rows[0];
    if (!row) return undefined;
    return { id: row.id, guildId: row.guild_id, actorId: row.actor_id, sources: row.sources,
      destinationId: row.destination_id, snapshotAt: row.snapshot_at?.getTime() ?? null, botsSkipped: row.bots_skipped,
      status: row.status, reason: row.reason, createdAt: row.created_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null, members: row.members };
  }

  async cancellationRequested(id: string): Promise<boolean> {
    return Boolean((await this.pool.query('SELECT cancel_requested FROM voice_move_jobs WHERE id=$1', [id])).rows[0]?.cancel_requested);
  }

  async cancel(id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM voice_move_jobs WHERE id=$1 FOR UPDATE', [id]);
      await client.query("UPDATE voice_move_members SET status='skipped',reason='user_cancelled',updated_at=now() WHERE job_id=$1 AND status='pending'", [id]);
      await client.query("UPDATE voice_move_jobs SET status='Cancelled',reason='user_cancelled',finished_at=now() WHERE id=$1 AND status='Running'", [id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async recover(guildId: string): Promise<void> {
    // Called only after acquiring the existing process lease for this guild.
    const jobs = await this.pool.query("SELECT id FROM voice_move_jobs WHERE guild_id=$1 AND status='Running'", [guildId]);
    for (const job of jobs.rows) await this.finish(job.id, 'service_restarted');
  }

  async prune(guildId: string): Promise<void> {
    await this.pool.query("DELETE FROM voice_move_jobs WHERE guild_id=$1 AND finished_at < now() - interval '90 days'", [guildId]);
  }
}
