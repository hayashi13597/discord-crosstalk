import { ChannelType, DiscordAPIError, HTTPError, PermissionFlagsBits, RateLimitError, REST, Routes, Status,
  type Guild, type VoiceChannel } from 'discord.js';
import { UserError } from './types.js';
import { MoveInterrupted, RetryMove, type MemberOutcome, type MoveGateway } from './voice-moves.js';
import type { MoveInput, MoveMember, MoveSnapshot } from './voice-move-types.js';

/** Separate move transport: never transparently retry a PATCH after timeout/5xx.
 * Rejected rate limits are returned to the worker for a fresh eligibility check. */
export function createMoveRest(token: string): REST {
  return new REST({ version: '10', timeout: 5000, retries: 0, rejectOnRateLimit: () => true }).setToken(token);
}
export async function requireMoveAdmin(guild: Guild, actorId: string): Promise<void> {
  await guild.roles.fetch();
  const actor = await guild.members.fetch({ user: actorId, force: true });
  if (!actor.permissions.has(PermissionFlagsBits.MoveMembers) ||
      !(actor.permissions.has(PermissionFlagsBits.ManageGuild) || actor.permissions.has(PermissionFlagsBits.Administrator))) {
    throw new UserError('Bạn cần Move Members và Manage Server hoặc Administrator.');
  }
}

class ChannelCheckError extends UserError {
  constructor(message: string, readonly reason: string) { super(message); }
}
// Share conservative reservations across previews/jobs on the same gateway, including
// PATCHes with unknown outcomes. Never alter the cache used by relay listeners.
const arrivalReservations = new WeakMap<Guild, Map<string, string>>();
export class DiscordMoveGateway implements MoveGateway {
  private arrivals: Map<string, string>;
  constructor(private guild: Guild, private rest: REST) {
    this.arrivals = arrivalReservations.get(guild) ?? new Map();
    arrivalReservations.set(guild, this.arrivals);
  }
  ready(): boolean {
    return this.guild.available && this.guild.client.isReady() && this.guild.shard.status === Status.Ready;
  }
  private ensureReady() { if (!this.ready()) throw new MoveInterrupted('gateway_unavailable'); }
  private async voiceChannel(id: string): Promise<VoiceChannel> {
    const channel = await this.guild.channels.fetch(id, { force: true });
    if (channel?.type !== ChannelType.GuildVoice || channel.guildId !== this.guild.id) {
      throw new ChannelCheckError(`Channel ${id} không tồn tại hoặc không phải voice channel thường trong server này. Hãy sửa lựa chọn.`, 'channel_unavailable');
    }
    return channel;
  }
  private occupancy(channelId: string) {
    for (const [id, destinationId] of this.arrivals) if (this.guild.voiceStates.cache.get(id)?.channelId === destinationId) this.arrivals.delete(id);
    return [...this.guild.voiceStates.cache.values()].filter(state => state.channelId === channelId).length +
      [...this.arrivals.values()].filter(destinationId => destinationId === channelId).length;
  }
  private async permissions(sourceIds: string[], destinationId: string) {
    const me = await this.guild.members.fetchMe({ force: true });
    const destination = await this.voiceChannel(destinationId);
    const check = (channel: VoiceChannel, label: string) => {
      const permissions = channel.permissionsFor(me);
      const required = [[PermissionFlagsBits.ViewChannel, 'View Channel'], [PermissionFlagsBits.Connect, 'Connect'], [PermissionFlagsBits.MoveMembers, 'Move Members']] as const;
      const missing = required.filter(([flag]) => !permissions?.has(flag)).map(([, name]) => name);
      if (missing.length) throw new ChannelCheckError(`Bot thiếu ${missing.join(', ')} tại ${label}.`, 'missing_permissions');
    };
    check(destination, 'channel đích');
    for (const id of sourceIds) {
      const source = await this.voiceChannel(id);
      // Connect is also required by Discord's fresh voice-state GET endpoint.
      check(source, `nguồn ${id}`);
    }
    return destination;
  }
  async validate(input: MoveInput): Promise<void> {
    this.ensureReady();
    if (input.guildId !== this.guild.id || !input.sources.length || !input.destinationId || input.sources.some(source => source.id === input.destinationId)) {
      throw new UserError('Cần ít nhất một nguồn và một đích khác mọi nguồn, trong cùng server.');
    }
    await requireMoveAdmin(this.guild, input.actorId);
    const destination = await this.permissions(input.sources.map(source => source.id), input.destinationId);
    if (destination.userLimit && this.occupancy(destination.id) + input.members.length > destination.userLimit) {
      throw new UserError('Channel đích không đủ chỗ cho toàn bộ snapshot. Hãy chọn đích khác hoặc sửa nguồn rồi xem trước lại.');
    }
    this.ensureReady();
  }

  async snapshot(actorId: string, sourceIds: string[], destinationId: string): Promise<MoveSnapshot> {
    const sources = [...new Set(sourceIds)].map(id => ({ id, humans: 0, bots: 0 }));
    const input: MoveInput = { id: '', actorId, guildId: this.guild.id, sources, destinationId,
      snapshotAt: null, botsSkipped: 0, members: [] };
    await this.validate(input);
    const takenAt = Date.now();
    // Copy IDs and channels together before awaiting: arrivals during member verification
    // cannot silently enlarge the snapshot or shift a member to a different source.
    const occupants = [...this.guild.voiceStates.cache.values()]
      .filter(state => sources.some(source => source.id === state.channelId))
      .map(state => ({ userId: state.id, sourceId: state.channelId! }));
    const seen = new Set<string>();
    for (const occupant of occupants) {
      if (seen.has(occupant.userId)) continue;
      seen.add(occupant.userId);
      const member = await this.guild.members.fetch({ user: occupant.userId, force: true });
      const source = sources.find(source => source.id === occupant.sourceId)!;
      if (member.user.bot) { source.bots++; input.botsSkipped++; }
      else { source.humans++; input.members.push(occupant); }
    }
    await this.validate(input);
    if (!input.members.length) throw new UserError('Không có người dùng thực đủ điều kiện trong các nguồn.');
    const destination = await this.voiceChannel(destinationId);
    if (Date.now() - takenAt >= 60000) throw new UserError('Quá trình xác minh kéo dài; snapshot đã cũ. Hãy xem trước lại.');
    return { sources, destinationId, destinationLimit: destination.userLimit, destinationOccupancy: this.occupancy(destinationId),
      members: input.members, botsSkipped: input.botsSkipped, takenAt };
  }

  async move(member: MoveMember, input: MoveInput, signal: AbortSignal): Promise<MemberOutcome> {
    this.ensureReady();
    let submitted = false;
    const unknown = (): MemberOutcome => {
      this.arrivals.set(member.userId, input.destinationId!);
      return { status: 'unknown', reason: 'outcome_unknown' };
    };
    try {
      const human = await this.guild.members.fetch({ user: member.userId, force: true });
      if (human.user.bot) return { status: 'skipped', reason: 'bot_account' };
      // Raw REST deliberately avoids VoiceStateManager.fetch(), which patches the
      // shared cache before VoiceStateUpdate can revoke a leader's relay capture.
      const voice = await this.rest.get(Routes.guildVoiceState(this.guild.id, member.userId), { signal }) as { channel_id: string | null };
      if (voice.channel_id === input.destinationId) return { status: 'skipped', reason: 'already_at_destination' };
      if (!voice.channel_id || !input.sources.some(source => source.id === voice.channel_id)) return { status: 'skipped', reason: 'left_sources' };
      const destination = await this.permissions([voice.channel_id], input.destinationId!);
      if (destination.userLimit && this.occupancy(destination.id) >= destination.userLimit) return { status: 'failed', reason: 'destination_full' };
      this.ensureReady();
      signal.throwIfAborted();
      // Do not overwrite a newer gateway departure received during permission checks.
      const cached = this.guild.voiceStates.cache.get(member.userId);
      if (!cached?.channelId || !input.sources.some(source => source.id === cached.channelId)) return { status: 'skipped', reason: 'left_sources' };
      submitted = true;
      // Once sent, allow the current PATCH to finish within the transport's 5s
      // timeout on shutdown. The stop signal still prevents starting a new PATCH.
      await this.rest.patch(Routes.guildMember(this.guild.id, member.userId), { body: { channel_id: input.destinationId },
        reason: `Mass Voice Move ${input.id}; actor ${input.actorId}` });
      // Account for successful arrivals before gateway events, without mutating voice
      // state caches used by the relay's leader-departure detection.
      this.arrivals.set(member.userId, input.destinationId!);
      return { status: 'moved', reason: null };
    } catch (error) {
      if (error instanceof MoveInterrupted || (signal.aborted && !submitted)) throw new MoveInterrupted('gateway_or_shutdown');
      if (error instanceof RateLimitError) throw new RetryMove(Math.max(error.retryAfter, error.timeToReset, error.sublimitTimeout, 1));
      if (error instanceof ChannelCheckError) return { status: 'failed', reason: error.reason };
      if (error instanceof DiscordAPIError) {
        if ([10007, 10065, 40032].includes(Number(error.code))) return { status: 'skipped', reason: 'left_sources' };
        if (error.status >= 500) return submitted ? unknown() : { status: 'failed', reason: 'discord_unavailable' };
        return { status: 'failed', reason: [50001, 50013].includes(Number(error.code)) ? 'missing_permissions' : `discord_${error.code}` };
      }
      if (error instanceof HTTPError && error.status >= 400 && error.status < 500) return { status: 'failed', reason: `discord_http_${error.status}` };
      // Never resend an ambiguous request. Its outcome must be checked by an admin.
      return submitted ? unknown() : { status: 'failed', reason: 'voice_state_unverified' };
    }
  }
}
