import { randomUUID } from 'node:crypto';
import type { LocalDatabase, LocalClient } from './sqlite.js';
import type { Config } from './config.js';
import { CommitUncertainError } from './database-errors.js';
import { UserError, targetVersion, type RelayMutation, type RelaySnapshot } from './types.js';

import type { RelayRepository } from './relay-repository.js';

export class SqliteRelays implements RelayRepository {
  constructor(readonly pool: LocalDatabase, readonly config: Config) {}

  private async transaction<T>(work: (client: LocalClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let committing = false;
    try {
      await client.query('BEGIN');
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

  private async load(client: LocalClient): Promise<RelaySnapshot> {
    const groups = await client.query('SELECT id, name, state, legacy FROM relay_groups WHERE guild_id = $1 ORDER BY legacy DESC, id', [this.config.guildId]);
    const teams = await client.query(`SELECT id, group_id AS "groupId", channel_id AS "channelId",
      worker_id AS "workerId" FROM relay_teams WHERE guild_id = $1 ORDER BY worker_id`, [this.config.guildId]);
    return { groups: groups.rows.map(row => ({ ...row, legacy: Boolean(row.legacy) })), teams: teams.rows };
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
        await client.query("INSERT INTO relay_audit(guild_id, actor_id, action, details) VALUES ($1,'system','guild.initialize',$2)", [guild, JSON.stringify({ groupId })]);
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
        case 'group.create': {
          const name = action.name.trim();
          if (!name || name.length > 80 || /[\r\n\x00-\x1f]/.test(name)) throw new UserError('Tên group phải có 1–80 ký tự và không chứa ký tự điều khiển.');
          if (snapshot.groups.some(other => other.name.toLowerCase() === name.toLowerCase())) throw new UserError('Tên group đã được sử dụng.');
          await client.query("INSERT INTO relay_groups(id,guild_id,name,state) VALUES ($1,$2,$3,'paused')", [randomUUID(), guild, name]);
          break;
        }
        case 'group.state':
          if (action.state === 'active') {
            const missing = snapshot.teams.filter(team => team.groupId === group!.id && !this.config.workers.some(worker => worker.id === team.workerId));
            if (missing.length) throw new UserError('Thiếu token cho bot đã phân công. Hãy khôi phục BOT_TOKEN_n trước khi resume.');
          }
          await client.query('UPDATE relay_groups SET state=$3 WHERE guild_id=$1 AND id=$2', [guild, group!.id, action.state]);
          break;
        case 'group.delete':
          if (group!.legacy) throw new UserError('Không được xóa Group A mặc định.');
          await client.query('DELETE FROM relay_teams WHERE guild_id=$1 AND group_id=$2', [guild, group!.id]);
          await client.query('DELETE FROM relay_groups WHERE guild_id=$1 AND id=$2', [guild, group!.id]);
          break;
        case 'team.add': {
          if (snapshot.teams.some(team => team.channelId === action.channelId)) throw new UserError('Voice channel đã được gán cho một team/group khác.');
          const worker = this.config.workers.find(worker => !snapshot.teams.some(team => team.workerId === worker.id));
          if (!worker) throw new UserError('Không còn bot account trống. Hãy bổ sung BOT_TOKEN_n.');
          await client.query('INSERT INTO relay_teams(id,guild_id,group_id,channel_id,worker_id) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), guild, group!.id, action.channelId, worker.id]);
          break;
        }
        case 'team.remove':
          await client.query('DELETE FROM relay_teams WHERE guild_id=$1 AND id=$2', [guild, team!.id]);
          break;
      }
      await client.query('INSERT INTO relay_audit(guild_id,actor_id,action,details) VALUES ($1,$2,$3,$4)', [guild, actorId, action.kind, JSON.stringify({ ...action, groupId: group?.id ?? team?.groupId, before: snapshot, after: await this.load(client) })]);
      return this.load(client);
    });
  }
}
