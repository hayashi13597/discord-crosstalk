import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Config } from './config.js';
import { CommitUncertainError } from './database.js';
import { TEAMS, UserError, targetVersion, type RelayMutation, type RelaySnapshot, type RelayTeam } from './types.js';

export interface RelayRepository {
  initialize(): Promise<RelaySnapshot>;
  mutate(action: RelayMutation, actorId: string): Promise<RelaySnapshot>;
  identify(workerId: number, userId: string): Promise<void>;
  healthy(): Promise<boolean>;
}

export class PostgresRelays implements RelayRepository {
  constructor(readonly pool: pg.Pool, readonly config: Config) {}

  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let committing = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`crosstalk:relays:${this.config.guildId}`]);
      const value = await work(client);
      committing = true;
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (committing) throw new CommitUncertainError(error);
      throw error;
    } finally { client.release(); }
  }

  private async load(client: pg.PoolClient): Promise<RelaySnapshot> {
    const groups = await client.query('SELECT id, name, state, legacy FROM relay_groups WHERE guild_id = $1 ORDER BY legacy DESC, id', [this.config.guildId]);
    const teams = await client.query(`SELECT id, group_id AS "groupId", channel_id AS "channelId", leader_id AS "leaderId",
      worker_id AS "workerId", legacy_slot AS "legacySlot", display_name AS name FROM relay_teams WHERE guild_id = $1 ORDER BY worker_id`, [this.config.guildId]);
    return { groups: groups.rows, teams: teams.rows.map(({ name, ...team }) => name ? { ...team, name } : team) };
  }

  initialize(): Promise<RelaySnapshot> {
    return this.transaction(async client => {
      const guild = this.config.guildId;
      const inserted = await client.query('INSERT INTO relay_guilds(guild_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING guild_id', [guild]);
      for (const worker of this.config.workers) {
        await client.query('INSERT INTO relay_workers(guild_id, worker_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [guild, worker.id]);
      }
      if (inserted.rowCount) {
        const groupId = randomUUID();
        await client.query("INSERT INTO relay_groups(id, guild_id, name, state, legacy) VALUES ($1,$2,'Group A','active',true)", [groupId, guild]);
        for (const team of TEAMS) {
          await client.query(`INSERT INTO relay_teams(id, guild_id, group_id, channel_id, leader_id, worker_id, legacy_slot)
            VALUES ($1,$2,$3,$4,(SELECT user_id FROM leader_assignments WHERE guild_id=$2 AND team_id=$5),$5,$5)`,
          [randomUUID(), guild, groupId, this.config.bots[team].channelId, team]);
        }
        await client.query("INSERT INTO relay_audit(guild_id, actor_id, action, details) VALUES ($1,'system','legacy.import',$2)", [guild, JSON.stringify({ groupId })]);
      }
      return this.load(client);
    });
  }

  async healthy(): Promise<boolean> {
    try { await this.pool.query('SELECT 1'); return true; } catch { return false; }
  }

  async identify(workerId: number, userId: string): Promise<void> {
    await this.transaction(async client => {
      const existing = await client.query('SELECT worker_id, user_id FROM relay_workers WHERE guild_id=$1', [this.config.guildId]);
      const own = existing.rows.find(row => row.worker_id === workerId);
      if (!own || (own.user_id && own.user_id !== userId) || existing.rows.some(row => row.worker_id !== workerId && row.user_id === userId)) {
        throw Object.assign(new Error('Worker bot identity mismatch or duplicate account'), { code: 'BOT_IDENTITY_CONFLICT' });
      }
      if (!own.user_id) await client.query('UPDATE relay_workers SET user_id=$3 WHERE guild_id=$1 AND worker_id=$2', [this.config.guildId, workerId, userId]);
    });
  }

  mutate(action: RelayMutation, actorId: string): Promise<RelaySnapshot> {
    return this.transaction(async client => {
      const snapshot = await this.load(client);
      const guild = this.config.guildId;
      const group = 'groupId' in action ? snapshot.groups.find(group => group.id === action.groupId) : undefined;
      const team = 'teamId' in action ? snapshot.teams.find(team => team.id === action.teamId) : undefined;
      if ('groupId' in action && !group) throw new UserError('Group không còn tồn tại.');
      if ('teamId' in action && !team) throw new UserError('Team không còn tồn tại.');
      if ('expected' in action && action.expected !== undefined && action.expected !== targetVersion(snapshot, team ? 'team' : 'group', team?.id ?? group!.id)) {
        throw new UserError('Cấu hình đã thay đổi. Hãy chạy lại lệnh để xác nhận cấu hình mới.');
      }
      switch (action.kind) {
        case 'group.create':
        case 'group.rename': {
          const name = action.name.trim();
          if (!name || name.length > 80 || /[\r\n\x00-\x1f]/.test(name)) throw new UserError('Tên group phải có 1–80 ký tự và không chứa ký tự điều khiển.');
          if (snapshot.groups.some(other => other.id !== (action.kind === 'group.rename' ? action.groupId : '') && other.name.toLowerCase() === name.toLowerCase())) throw new UserError('Tên group đã được sử dụng.');
          if (action.kind === 'group.rename') {
            await client.query('UPDATE relay_groups SET name=$3 WHERE guild_id=$1 AND id=$2', [guild, action.groupId, name]);
            break;
          }
          await client.query("INSERT INTO relay_groups(id,guild_id,name,state) VALUES ($1,$2,$3,'paused')", [randomUUID(), guild, name]);
          break;
        }
        case 'group.state':
          if (action.state === 'active') {
            const missing = snapshot.teams.filter(team => team.groupId === group!.id && !this.config.workers.some(worker => worker.id === team.workerId));
            if (missing.length) throw new UserError('Thiếu token cho bot đã phân công. Hãy khôi phục Railway Variables trước khi resume.');
          }
          await client.query('UPDATE relay_groups SET state=$3 WHERE guild_id=$1 AND id=$2', [guild, group!.id, action.state]);
          break;
        case 'group.delete':
          if (group!.legacy) throw new UserError('Không được xóa Group A chứa ánh xạ team cũ.');
          await client.query('DELETE FROM relay_teams WHERE guild_id=$1 AND group_id=$2', [guild, group!.id]);
          await client.query('DELETE FROM relay_groups WHERE guild_id=$1 AND id=$2', [guild, group!.id]);
          break;
        case 'team.add': {
          if (snapshot.teams.some(team => team.channelId === action.channelId)) throw new UserError('Voice channel đã được gán cho một team/group khác.');
          const worker = this.config.workers.find(worker => worker.id > 3 && (!action.workerId || worker.id === action.workerId) && !snapshot.teams.some(team => team.workerId === worker.id));
          if (!worker) throw new UserError('Không còn bot account trống. Hãy bổ sung BOT_TOKEN_n trên Railway; bot 1–3 được giữ cho các team cũ.');
          await client.query('INSERT INTO relay_teams(id,guild_id,group_id,channel_id,worker_id) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), guild, group!.id, action.channelId, worker.id]);
          break;
        }
        case 'team.update': {
          const name = action.name?.trim() || null;
          if (name && (name.length > 80 || /[\r\n\x00-\x1f]/.test(name))) throw new UserError('Tên team không hợp lệ.');
          const structural = action.groupId !== team!.groupId || action.channelId !== team!.channelId || action.workerId !== team!.workerId;
          if (structural) {
            if (team!.legacySlot) throw new UserError('Không thay đổi mapping của team gốc.');
            const previous = snapshot.groups.find(g => g.id === team!.groupId)!;
            if (previous.state !== 'paused' || group!.state !== 'paused') throw new UserError('Pause cả hai group trước khi thay đổi mapping.');
            if (snapshot.teams.some(t => t.id !== team!.id && (t.channelId === action.channelId || t.workerId === action.workerId))) throw new UserError('Channel hoặc worker đã được sử dụng.');
            if (action.workerId <= 3 || !this.config.workers.some(w => w.id === action.workerId)) throw new UserError('Worker không khả dụng.');
          }
          await client.query('UPDATE relay_teams SET display_name=$3,group_id=$4,channel_id=$5,worker_id=$6 WHERE guild_id=$1 AND id=$2',
            [guild, team!.id, name, action.groupId, action.channelId, action.workerId]);
          break;
        }
        case 'team.remove':
          await this.mirrorLeader(client, team!, null, actorId);
          await client.query('DELETE FROM relay_teams WHERE guild_id=$1 AND id=$2', [guild, team!.id]);
          break;
        case 'leader.change':
          if (action.userId && snapshot.teams.some(other => other.id !== team!.id && other.leaderId === action.userId)) throw new UserError('Người này đã là leader của team khác. Hãy gỡ phân công cũ trước.');
          await this.mirrorLeader(client, team!, action.userId, actorId);
          await client.query('UPDATE relay_teams SET leader_id=$3 WHERE guild_id=$1 AND id=$2', [guild, team!.id, action.userId]);
          break;
      }
      await client.query('INSERT INTO relay_audit(guild_id,actor_id,action,details) VALUES ($1,$2,$3,$4)', [guild, actorId, action.kind, JSON.stringify({ ...action, groupId: group?.id ?? team?.groupId, before: snapshot, after: await this.load(client) })]);
      return this.load(client);
    });
  }

  private async mirrorLeader(client: pg.PoolClient, team: RelayTeam, userId: string | null, actorId: string): Promise<void> {
    if (!team.legacySlot || team.leaderId === userId) return;
    const guild = this.config.guildId;
    if (userId) {
      await client.query(`INSERT INTO leader_assignments(guild_id,team_id,user_id) VALUES ($1,$2,$3)
        ON CONFLICT (guild_id,team_id) DO UPDATE SET user_id=EXCLUDED.user_id, updated_at=now()`, [guild, team.legacySlot, userId]);
    } else await client.query('DELETE FROM leader_assignments WHERE guild_id=$1 AND team_id=$2', [guild, team.legacySlot]);
    await client.query('INSERT INTO leader_audit(guild_id,team_id,old_user_id,new_user_id,actor_id) VALUES ($1,$2,$3,$4,$5)', [guild, team.legacySlot, team.leaderId, userId, actorId]);
  }
}
