import { ChannelType, DiscordAPIError, HTTPError, PermissionFlagsBits, RateLimitError, REST, Routes, Status,
  type Guild, type VoiceChannel } from 'discord.js';
import { UserError } from './types.js';
import { MoveInterrupted, MoveRetry, type MoveScan, type MemberOutcome, type MoveGateway } from './voice-moves.js';
import type { MoveInput, MoveMember, MoveSnapshot } from './voice-move-types.js';

/** Separate move transport: never transparently retry a PATCH after timeout/5xx.
 * Rate limits are surfaced to the worker so retries respect Discord cooldowns. */
export function createMoveRest(token: string): REST {
  return new REST({ version: '10', timeout: 5000, retries: 0, rejectOnRateLimit: () => true }).setToken(token);
}
export async function requireMoveAdmin(guild: Guild, actorId: string, refreshRoles = true): Promise<void> {
  if (refreshRoles || !guild.roles.cache?.size) await guild.roles.fetch();
  const actor = await guild.members.fetch({ user: actorId, force: true });
  if (!actor.permissions.has(PermissionFlagsBits.MoveMembers) ||
      !(actor.permissions.has(PermissionFlagsBits.ManageGuild) || actor.permissions.has(PermissionFlagsBits.Administrator))) {
    throw new UserError('Bạn cần Move Members và Manage Server hoặc Administrator.');
  }
}

class ChannelCheckError extends UserError {
  constructor(message: string, readonly reason: string) { super(message); }
}
// Share conservative reservations across snapshots/jobs on the same gateway, including
// PATCHes with unknown outcomes. Never alter the cache used by relay listeners.
const arrivalReservations = new WeakMap<Guild, Map<string, string>>();
export class DiscordMoveGateway implements MoveGateway {
  private arrivals: Map<string, string>;
  // Account bot flag is immutable in Discord; cache across snapshot/move/scan to avoid N*4 member REST fetches.
  private botUsers = new Map<string, boolean>();
  private verifiedChannels = new Set<string>();
  private preflightKey: string | null = null;
  private preflightAt = 0;

  constructor(private guild: Guild, private rest: REST) {
    this.arrivals = arrivalReservations.get(guild) ?? new Map();
    arrivalReservations.set(guild, this.arrivals);
  }
  ready(): boolean {
    return this.guild.available && this.guild.client.isReady() && this.guild.shard.status === Status.Ready;
  }
  private ensureReady() { if (!this.ready()) throw new MoveInterrupted('gateway_unavailable'); }

  private async isBot(userId: string): Promise<boolean> {
    const known = this.botUsers.get(userId);
    if (known !== undefined) return known;
    const cached = this.guild.members.cache?.get(userId);
    if (cached) {
      this.botUsers.set(userId, cached.user.bot);
      return cached.user.bot;
    }
    const member = await this.guild.members.fetch({ user: userId, force: true });
    this.botUsers.set(userId, member.user.bot);
    return member.user.bot;
  }

  private async voiceChannel(id: string, force = true): Promise<VoiceChannel> {
    let channel: unknown = !force && this.verifiedChannels.has(id) ? this.guild.channels.cache?.get(id) : undefined;
    if (!channel) {
      const refresh = force || Boolean(this.verifiedChannels.has(id) && this.guild.channels.cache);
      channel = await this.guild.channels.fetch(id, { force: refresh }).catch(error => {
        if (error instanceof DiscordAPIError && Number(error.code) === 10003) return null;
        throw error;
      });
      if (channel) this.verifiedChannels.add(id);
      else this.verifiedChannels.delete(id);
    }
    if (!channel || (channel as VoiceChannel).type !== ChannelType.GuildVoice || (channel as VoiceChannel).guildId !== this.guild.id) {
      throw new ChannelCheckError(`Channel ${id} không tồn tại hoặc không phải voice channel thường trong server này. Hãy kiểm tra cấu hình rồi chạy lại /voice move-all.`, 'channel_unavailable');
    }
    return channel as VoiceChannel;
  }
  private occupancy(channelId: string) {
    for (const [id, destinationId] of this.arrivals) if (this.guild.voiceStates.cache.get(id)?.channelId === destinationId) this.arrivals.delete(id);
    return [...this.guild.voiceStates.cache.values()].filter(state => state.channelId === channelId).length +
      [...this.arrivals.values()].filter(destinationId => destinationId === channelId).length;
  }
  private async permissions(sourceIds: string[], destinationId: string, force = true) {
    const me = (!force && this.guild.members.me) ? this.guild.members.me : await this.guild.members.fetchMe({ force });
    const destination = await this.voiceChannel(destinationId, force);
    const check = (channel: VoiceChannel, label: string) => {
      const permissions = channel.permissionsFor(me);
      const required = [[PermissionFlagsBits.ViewChannel, 'View Channel'], [PermissionFlagsBits.Connect, 'Connect'], [PermissionFlagsBits.MoveMembers, 'Move Members']] as const;
      const missing = required.filter(([flag]) => !permissions?.has(flag)).map(([, name]) => name);
      if (missing.length) throw new ChannelCheckError(`Bot thiếu ${missing.join(', ')} tại ${label}.`, 'missing_permissions');
    };
    check(destination, 'channel đích');
    for (const id of sourceIds) {
      const source = await this.voiceChannel(id, force);
      // Connect is also required by Discord's fresh voice-state GET endpoint.
      check(source, `nguồn ${id}`);
    }
    return destination;
  }
  private signatureFor(actorId: string, destinationId: string, sourceIds: string[]): string {
    return JSON.stringify([actorId, destinationId, sourceIds]);
  }
  async validate(input: MoveInput): Promise<void> {
    this.ensureReady();
    if (input.guildId !== this.guild.id || !input.sources.length || !input.destinationId || input.sources.some(source => source.id === input.destinationId)) {
      throw new UserError('Cần ít nhất một nguồn và một đích khác mọi nguồn, trong cùng server.');
    }
    const sourceIds = input.sources.map(source => source.id);
    const recentPreflight = this.preflightKey === this.signatureFor(input.actorId, input.destinationId, sourceIds) &&
      Date.now() - this.preflightAt < 2000;
    this.preflightKey = null;
    if (!recentPreflight) await requireMoveAdmin(this.guild, input.actorId);
    const destination = await this.permissions(sourceIds, input.destinationId, !recentPreflight);
    if (destination.userLimit && this.occupancy(destination.id) + input.members.length > destination.userLimit) {
      throw new UserError('Channel đích không đủ chỗ cho toàn bộ snapshot. Hãy kiểm tra cấu hình /voice move-config và cài lại nguồn/đích.');
    }
    this.ensureReady();
  }

  async snapshot(actorId: string, sourceIds: string[], destinationId: string): Promise<MoveSnapshot> {
    const sources = [...new Set(sourceIds)].map(id => ({ id, humans: 0, bots: 0 }));
    const uniqueSourceIds = sources.map(source => source.id);
    const input: MoveInput = { id: '', actorId, guildId: this.guild.id, sources, destinationId,
      snapshotAt: null, botsSkipped: 0, members: [] };
    let preflightCheckedAt = Date.now();
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
      const bot = await this.isBot(occupant.userId);
      const source = sources.find(source => source.id === occupant.sourceId)!;
      if (bot) { source.bots++; input.botsSkipped++; }
      else { source.humans++; input.members.push(occupant); }
    }
    this.ensureReady();
    const recheckStartedAt = Date.now();
    const refreshPermissions = recheckStartedAt - preflightCheckedAt >= 2000;
    await requireMoveAdmin(this.guild, actorId);
    const destination = await this.permissions(uniqueSourceIds, destinationId, refreshPermissions);
    if (refreshPermissions) preflightCheckedAt = recheckStartedAt;
    if (destination.userLimit && this.occupancy(destination.id) + input.members.length > destination.userLimit) {
      throw new UserError('Channel đích không đủ chỗ cho toàn bộ snapshot. Hãy kiểm tra cấu hình /voice move-config và cài lại nguồn/đích.');
    }
    if (Date.now() - takenAt >= 60000) throw new UserError('Quá trình xác minh kéo dài; snapshot đã cũ. Hãy kiểm tra cấu hình rồi chạy lại /voice move-all.');
    this.preflightKey = this.signatureFor(actorId, destinationId, uniqueSourceIds);
    this.preflightAt = preflightCheckedAt;
    return { sources, destinationId, destinationLimit: destination.userLimit, destinationOccupancy: this.occupancy(destinationId),
      members: input.members, botsSkipped: input.botsSkipped, takenAt };
  }

  async scan(input: MoveInput, signal: AbortSignal): Promise<MoveScan> {
    this.ensureReady();
    try {
      await requireMoveAdmin(this.guild, input.actorId, false);
      await this.permissions(input.sources.map(source => source.id), input.destinationId!, false);
    } catch (error) {
      if (error instanceof RateLimitError) throw new MoveRetry(Math.max(error.retryAfter, error.timeToReset, error.sublimitTimeout, 1));
      if (error instanceof ChannelCheckError) throw new MoveInterrupted(error.reason);
      if (error instanceof DiscordAPIError && Number(error.code) === 10003) throw new MoveInterrupted('channel_unavailable');
      if (error instanceof DiscordAPIError && [50001, 50013].includes(Number(error.code))) throw new MoveInterrupted('missing_permissions');
      if (error instanceof UserError) throw new MoveInterrupted('missing_permissions');
      throw error;
    }
    const result: MoveScan = { checkedAt: Date.now(), remaining: [], resolved: [], unverified: [] };
    const candidates = new Set([
      ...input.members.map(member => member.userId),
      ...[...this.guild.voiceStates.cache.values()].filter(state => input.sources.some(source => source.id === state.channelId)).map(state => state.id),
    ]);
    for (const userId of candidates) {
      signal.throwIfAborted();
      this.ensureReady();
      try {
        if (await this.isBot(userId)) continue;
        const voice = await this.rest.get(Routes.guildVoiceState(this.guild.id, userId), { signal }) as { channel_id: string | null };
        // An explicit read supersedes conservative capacity reservations from earlier requests.
        if (voice.channel_id === input.destinationId) this.arrivals.set(userId, input.destinationId!);
        else this.arrivals.delete(userId);
        if (voice.channel_id && input.sources.some(source => source.id === voice.channel_id)) {
          result.remaining.push({ userId, sourceId: voice.channel_id });
        } else {
          result.resolved.push({ userId, status: 'skipped', reason: voice.channel_id === input.destinationId ? 'already_at_destination' : 'left_sources' });
        }
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof RateLimitError) throw new MoveRetry(Math.max(error.retryAfter, error.timeToReset, error.sublimitTimeout, 1));
        if (error instanceof DiscordAPIError && [10007, 10065, 40032].includes(Number(error.code))) {
          this.arrivals.delete(userId);
          result.resolved.push({ userId, status: 'skipped', reason: 'left_sources' });
        } else result.unverified.push(userId);
      }
    }
    this.ensureReady();
    result.checkedAt = Date.now();
    return result;
  }

  async move(member: MoveMember, input: MoveInput, signal: AbortSignal): Promise<MemberOutcome> {
    this.ensureReady();
    let submitted = false;
    const unknown = (): MemberOutcome => {
      this.arrivals.set(member.userId, input.destinationId!);
      return { status: 'unknown', reason: 'outcome_unknown' };
    };
    try {
      if (await this.isBot(member.userId)) return { status: 'skipped', reason: 'bot_account' };
      const cachedBefore = this.guild.voiceStates.cache.get(member.userId)?.channelId;
      // Raw REST deliberately avoids VoiceStateManager.fetch(), which patches the
      // shared cache before VoiceStateUpdate can revoke a leader's relay capture.
      const voice = await this.rest.get(Routes.guildVoiceState(this.guild.id, member.userId), { signal }) as { channel_id: string | null };
      if (voice.channel_id === input.destinationId) {
        this.arrivals.set(member.userId, input.destinationId!);
        return { status: 'skipped', reason: 'already_at_destination' };
      }
      this.arrivals.delete(member.userId);
      if (!voice.channel_id || !input.sources.some(source => source.id === voice.channel_id)) return { status: 'skipped', reason: 'left_sources' };
      const destination = await this.permissions([voice.channel_id], input.destinationId!, false);
      if (destination.userLimit && this.occupancy(destination.id) >= destination.userLimit) return { status: 'failed', reason: 'destination_full' };
      this.ensureReady();
      signal.throwIfAborted();
      // Skip only when a newer gateway event arrived during checks moving the user out of sources;
      // never let an unchanged/lagging gateway cache override the authoritative REST position read above.
      const cachedNow = this.guild.voiceStates.cache.get(member.userId)?.channelId;
      if (cachedNow !== cachedBefore && (!cachedNow || !input.sources.some(source => source.id === cachedNow))) {
        return { status: 'skipped', reason: 'left_sources' };
      }
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
      if (error instanceof RateLimitError) return { status: 'failed', reason: 'rate_limited',
        retryAfterMs: Math.max(error.retryAfter, error.timeToReset, error.sublimitTimeout, 1) };
      if (error instanceof ChannelCheckError) return { status: 'failed', reason: error.reason };
      if (error instanceof DiscordAPIError) {
        const code = Number(error.code);
        if ([10007, 10065, 40032].includes(code)) return { status: 'skipped', reason: 'left_sources' };
        if (error.status >= 500) return submitted ? unknown() : { status: 'failed', reason: 'discord_unavailable' };
        if (code === 10003) return { status: 'failed', reason: 'channel_unavailable' };
        return { status: 'failed', reason: [50001, 50013].includes(code) ? 'missing_permissions' : `discord_${error.code}` };
      }
      if (error instanceof HTTPError && error.status >= 400 && error.status < 500) return { status: 'failed', reason: `discord_http_${error.status}` };
      // Never resend an ambiguous request. Its outcome must be checked by an admin.
      return submitted ? unknown() : { status: 'failed', reason: 'voice_state_unverified' };
    }
  }
}
