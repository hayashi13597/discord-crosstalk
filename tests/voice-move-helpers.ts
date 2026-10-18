import { vi } from 'vitest';
import type { Guild, REST } from 'discord.js';
import { ChannelType, PermissionFlagsBits, Status } from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { MoveInput, MoveJob, MemberStatus, VoiceMoveRepository } from '../src/voice-move-types.js';

export function moveInput(count = 3): MoveInput {
  return { id: randomUUID(), guildId: 'guild', actorId: 'admin', sources: [{ id: 'a', humans: count, bots: 0 }],
    destinationId: 'd', botsSkipped: 0, snapshotAt: Date.now(),
    members: Array.from({ length: count }, (_, index) => ({ userId: `user${index}`, sourceId: 'a' })) };
}
export class MemoryMoves implements VoiceMoveRepository {
  jobs = new Map<string, MoveJob>();
  create = vi.fn(async (input: MoveInput, reason?: string) => {
    if (this.jobs.has(input.id)) throw new Error('duplicate ID');
    this.jobs.set(input.id, { ...structuredClone(input), status: reason ? 'Cancelled' : 'Running', reason: reason ?? null,
      createdAt: new Date().toISOString(), finishedAt: reason ? new Date().toISOString() : null,
      members: input.members.map(member => ({ ...member, status: reason ? 'skipped' : 'pending', reason: reason ?? null })) });
  });
  processing = vi.fn(async (id: string, userId: string) => { this.member(id, userId).status = 'processing'; });
  outcome = vi.fn(async (id: string, userId: string, status: 'moved' | 'skipped' | 'failed' | 'unknown', reason: string | null) => {
    Object.assign(this.member(id, userId), { status, reason });
  });
  finish = vi.fn(async (id: string, interrupted?: string) => {
    const job = this.jobs.get(id)!;
    if (interrupted) {
      job.reason = interrupted;
      job.status = 'Interrupted';
      for (const member of job.members) if (['pending', 'processing'].includes(member.status)) {
        member.reason = member.status === 'processing' ? 'outcome_unknown' : interrupted;
        member.status = member.status === 'processing' ? 'unknown' : 'failed';
      }
    } else {
      const failed = job.members.some(member => ['failed', 'unknown'].includes(member.status));
      job.status = failed ? job.members.some(member => member.status === 'moved') ? 'Partially Completed' : 'Failed' : 'Completed';
    }
    job.finishedAt = new Date().toISOString();
  });
  get = vi.fn(async (id: string, guildId: string) => {
    const job = this.jobs.get(id);
    return job?.guildId === guildId ? structuredClone(job) : undefined;
  });
  async recover(guildId: string) { for (const job of this.jobs.values()) if (job.guildId === guildId && job.status === 'Running') await this.finish(job.id, 'service_restarted'); }
  async prune() {}
  private member(id: string, userId: string) { return this.jobs.get(id)!.members.find(member => member.userId === userId)!; }
}

export function discordHarness() {
  const permissions = new Set<bigint>([PermissionFlagsBits.MoveMembers, PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel]);
  const botPermissions = new Set(permissions);
  const has = (set: Set<bigint>, values: bigint | bigint[]) => (Array.isArray(values) ? values : [values]).every(value => set.has(value));
  const cache = new Map<string, { id: string; channelId: string | null }>();
  const members = new Map<string, { id: string; user: { bot: boolean } }>();
  const channels = new Map<string, { id: string; guildId: string; type: ChannelType; userLimit: number; permissionsFor: ReturnType<typeof vi.fn> }>();
  const addChannel = (id: string) => {
    const channel = { id, guildId: 'guild', type: ChannelType.GuildVoice, userLimit: 0,
      permissionsFor: vi.fn(() => ({ has: (values: bigint | bigint[]) => has(botPermissions, values) })) };
    channels.set(id, channel); return channel;
  };
  for (const id of ['a', 'b', 'c', 'd']) addChannel(id);
  const addMember = (id: string, source: string, bot = false) => {
    members.set(id, { id, user: { bot } }); cache.set(id, { id, channelId: source });
  };
  addMember('human', 'a'); addMember('leader', 'b'); addMember('relay', 'a', true);
  const actor = { permissions: { has: (value: bigint) => has(permissions, value) } };
  const guild = {
    id: 'guild', available: true, client: { isReady: vi.fn(() => true) }, shard: { status: Status.Ready },
    roles: { fetch: vi.fn(async () => new Map()) },
    members: { fetchMe: vi.fn(async () => ({ id: 'bot1' })), fetch: vi.fn(async ({ user }: { user: string }) => user === 'admin' ? actor : members.get(user)) },
    channels: { fetch: vi.fn(async (id: string) => channels.get(id) ?? null) },
    voiceStates: { cache, fetch: vi.fn(async (id: string) => cache.get(id) ?? { id, channelId: null }) },
  };
  const patch = vi.fn(async (_route: string, _options: unknown) => ({}));
  const get = vi.fn(async (route: string, _options: unknown) => {
    const id = route.split('/').at(-1)!;
    return { channel_id: cache.get(id)?.channelId ?? null };
  });
  const rest = { patch, get } as unknown as REST;
  return { guild: guild as unknown as Guild, rawGuild: guild, rest, patch, get, permissions, botPermissions, cache, channels, members, addChannel, addMember };
}
