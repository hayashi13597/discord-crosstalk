import { describe, expect, it } from 'vitest';
import { ChannelType, DiscordAPIError, PermissionFlagsBits, RateLimitError } from 'discord.js';
import { createMoveRest, DiscordMoveGateway, requireMoveAdmin } from '../src/voice-move-discord.js';
import { discordHarness, moveInput } from './voice-move-helpers.js';

describe('Discord mass move eligibility', () => {
  it('snapshots all selected sources, excludes every bot, and includes leaders regardless of group', async () => {
    const state = discordHarness();
    const gateway = new DiscordMoveGateway(state.guild, state.rest);
    for (let index = 0; index < 30; index++) { state.addChannel(`s${index}`); state.addMember(`u${index}`, `s${index}`); }
    const snapshot = await gateway.snapshot('admin', ['a', 'b', 'a', ...Array.from({ length: 30 }, (_, index) => `s${index}`)], 'd');
    expect(snapshot.sources).toHaveLength(32);
    expect(snapshot.members).toHaveLength(32);
    expect(snapshot.botsSkipped).toBe(1);
    expect(snapshot.members.some(member => member.userId === 'leader')).toBe(true);
    expect(snapshot.members.some(member => member.userId === 'relay')).toBe(false);
  });
  it.each([PermissionFlagsBits.MoveMembers, PermissionFlagsBits.ManageGuild])('requires both caller permission categories (%s)', async removed => {
    const state = discordHarness();
    state.permissions.delete(removed);
    await expect(requireMoveAdmin(state.guild, 'admin')).rejects.toThrow('Move Members');
    expect(state.patch).not.toHaveBeenCalled();
  });
  it('accepts Administrator with effective Move Members', async () => {
    const state = discordHarness();
    state.permissions.delete(PermissionFlagsBits.ManageGuild);
    state.permissions.add(PermissionFlagsBits.Administrator);
    await expect(requireMoveAdmin(state.guild, 'admin')).resolves.toBeUndefined();
  });
  it('rejects missing channels, Stage, overlapping destination, empty sources and insufficient capacity', async () => {
    const state = discordHarness();
    const gateway = new DiscordMoveGateway(state.guild, state.rest);
    await expect(gateway.snapshot('admin', ['a'], 'a')).rejects.toThrow('khác');
    await expect(gateway.snapshot('admin', [], 'd')).rejects.toThrow('ít nhất');
    await expect(gateway.snapshot('admin', ['deleted'], 'd')).rejects.toThrow('không tồn tại');
    state.channels.get('c')!.type = ChannelType.GuildStageVoice;
    await expect(gateway.snapshot('admin', ['c'], 'd')).rejects.toThrow('voice channel thường');
    state.channels.get('d')!.userLimit = 1;
    await expect(gateway.snapshot('admin', ['a', 'b'], 'd')).rejects.toThrow('không đủ chỗ');
  });
  it('allows empty snapshots for final verification', async () => {
    const state = discordHarness();
    const gateway = new DiscordMoveGateway(state.guild, state.rest);
    expect((await gateway.snapshot('admin', ['a', 'c'], 'd')).sources.find(source => source.id === 'c')!.humans).toBe(0);
    expect((await gateway.snapshot('admin', ['c'], 'd')).members).toEqual([]);
  });
  it('freezes IDs before awaiting verification so late arrivals are not included', async () => {
    const state = discordHarness();
    const original = state.rawGuild.members.fetch.getMockImplementation()!;
    state.rawGuild.members.fetch.mockImplementation(async options => {
      if (options.user === 'human') state.addMember('late', 'a');
      return original(options);
    });
    const snapshot = await new DiscordMoveGateway(state.guild, state.rest).snapshot('admin', ['a'], 'd');
    expect(snapshot.members.map(member => member.userId)).toEqual(['human']);
  });
  it.each(['c', 'd', null])('skips a snapshot member now in %s without pulling them back', async channelId => {
    const state = discordHarness();
    state.cache.get('human')!.channelId = channelId;
    const outcome = await new DiscordMoveGateway(state.guild, state.rest).move({ userId: 'human', sourceId: 'a' }, moveInput(), new AbortController().signal);
    expect(outcome.status).toBe('skipped');
    expect(state.patch).not.toHaveBeenCalled();
    expect(state.get).toHaveBeenCalledWith('/guilds/guild/voice-states/human', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(state.rawGuild.voiceStates.fetch).not.toHaveBeenCalled();
  });
  it('does not move bots, and never mutates the voice cache used by relay leaders', async () => {
    const state = discordHarness();
    const gateway = new DiscordMoveGateway(state.guild, state.rest);
    const input = moveInput();
    expect((await gateway.move({ userId: 'relay', sourceId: 'a' }, input, new AbortController().signal)).status).toBe('skipped');
    expect((await gateway.move({ userId: 'human', sourceId: 'a' }, input, new AbortController().signal)).status).toBe('moved');
    expect(state.cache.get('human')!.channelId).toBe('a');
    expect(state.cache.get('relay')!.channelId).toBe('a');
    expect(state.patch).toHaveBeenCalledOnce();
    expect(state.patch.mock.calls[0]![1]).toEqual(expect.objectContaining({ body: { channel_id: 'd' } }));
  });
  it('accounts for arrivals before gateway updates so administrator privileges cannot overfill the destination', async () => {
    const state = discordHarness();
    state.channels.get('d')!.userLimit = 1;
    const gateway = new DiscordMoveGateway(state.guild, state.rest);
    const input = moveInput();
    input.sources.push({ id: 'b', humans: 1, bots: 0 });
    await gateway.move({ userId: 'human', sourceId: 'a' }, input, new AbortController().signal);
    expect(await gateway.move({ userId: 'leader', sourceId: 'b' }, input, new AbortController().signal)).toEqual({ status: 'failed', reason: 'destination_full' });
    expect(state.patch).toHaveBeenCalledOnce();
  });
  it('checks bot channel permissions again at execution', async () => {
    const state = discordHarness();
    const gateway = new DiscordMoveGateway(state.guild, state.rest);
    await gateway.snapshot('admin', ['a'], 'd');
    state.botPermissions.delete(PermissionFlagsBits.Connect);
    expect((await gateway.move({ userId: 'human', sourceId: 'a' }, moveInput(), new AbortController().signal)).status).toBe('failed');
    expect(state.patch).not.toHaveBeenCalled();
    await expect(gateway.snapshot('admin', ['a'], 'd')).rejects.toThrow('Bot thiếu Connect tại channel đích');
  });
  it('uses the fresh REST position without patching the relay cache when gateway events lag', async () => {
    const state = discordHarness();
    state.get.mockResolvedValueOnce({ channel_id: 'c' });
    const outcome = await new DiscordMoveGateway(state.guild, state.rest).move({ userId: 'human', sourceId: 'a' }, moveInput(), new AbortController().signal);
    expect(outcome).toEqual({ status: 'skipped', reason: 'left_sources' });
    expect(state.cache.get('human')!.channelId).toBe('a');
    expect(state.patch).not.toHaveBeenCalled();
  });
  it('reserves destination capacity for unknown outcomes across subsequent jobs', async () => {
    const state = discordHarness();
    state.channels.get('d')!.userLimit = 1;
    state.patch.mockRejectedValueOnce(new Error('response lost'));
    const input = moveInput();
    input.sources.push({ id: 'b', humans: 1, bots: 0 });
    await new DiscordMoveGateway(state.guild, state.rest).move({ userId: 'human', sourceId: 'a' }, input, new AbortController().signal);
    const result = await new DiscordMoveGateway(state.guild, state.rest).move({ userId: 'leader', sourceId: 'b' }, input, new AbortController().signal);
    expect(result).toEqual({ status: 'failed', reason: 'destination_full' });
    expect(state.patch).toHaveBeenCalledOnce();
  });
  it('marks an ambiguous network error unknown for the worker to reconcile', async () => {
    const state = discordHarness();
    state.patch.mockRejectedValue(new Error('socket reset with secrets'));
    const outcome = await new DiscordMoveGateway(state.guild, state.rest).move({ userId: 'human', sourceId: 'a' }, moveInput(), new AbortController().signal);
    expect(outcome).toEqual({ status: 'unknown', reason: 'outcome_unknown' });
    expect(state.patch).toHaveBeenCalledOnce();
    expect(JSON.stringify(outcome)).not.toContain('secrets');
    const rest = createMoveRest('token');
    expect(rest.options.retries).toBe(0);
    expect(typeof rest.options.rejectOnRateLimit).toBe('function');
    rest.clearHashSweeper(); rest.clearHandlerSweeper();
  });
  it('returns the Discord cooldown to the worker without blindly resending', async () => {
    const state = discordHarness();
    state.patch.mockRejectedValue(new RateLimitError({ timeToReset: 1500, retryAfter: 1500, sublimitTimeout: 0,
      limit: 1, method: 'PATCH', hash: 'hash', url: '/route', route: '/route', majorParameter: 'guild', global: false, scope: 'user' }));
    await expect(new DiscordMoveGateway(state.guild, state.rest).move({ userId: 'human', sourceId: 'a' }, moveInput(), new AbortController().signal)).resolves.toEqual({ status: 'failed', reason: 'rate_limited', retryAfterMs: 1500 });
    expect(state.patch).toHaveBeenCalledOnce();
  });
  it('classifies Discord rejections without disclosing raw responses', async () => {
    const state = discordHarness();
    state.patch.mockRejectedValue(new DiscordAPIError({ code: 50013, message: 'missing permission' }, 50013, 403, 'PATCH', '/route', {}));
    expect(await new DiscordMoveGateway(state.guild, state.rest).move({ userId: 'human', sourceId: 'a' }, moveInput(), new AbortController().signal))
      .toEqual({ status: 'failed', reason: 'missing_permissions' });
  });
  it('rechecks position after a lost PATCH response and never resends if already at destination', async () => {
    const state = discordHarness();
    const gateway = new DiscordMoveGateway(state.guild, state.rest);
    const member = { userId: 'human', sourceId: 'a' };
    state.patch.mockImplementationOnce(async () => {
      state.positions.set('human', 'd');
      throw new Error('response lost');
    });
    const signal = new AbortController().signal;
    expect(await gateway.move(member, moveInput(), signal)).toMatchObject({ status: 'unknown' });
    expect(await gateway.move(member, moveInput(), signal)).toEqual({ status: 'skipped', reason: 'already_at_destination' });
    expect(state.patch).toHaveBeenCalledOnce();
    expect(state.cache.get('human')!.channelId).toBe('a');
    state.channels.get('d')!.userLimit = 1;
    expect(await gateway.move({ userId: 'leader', sourceId: 'b' }, { ...moveInput(), sources: [{ id: 'b', humans: 1, bots: 0 }] }, signal))
      .toMatchObject({ status: 'failed', reason: 'destination_full' });
    expect(state.patch).toHaveBeenCalledOnce();
  });
  it('does not resend if fresh position cannot be read after an ambiguous outcome', async () => {
    const state = discordHarness();
    const gateway = new DiscordMoveGateway(state.guild, state.rest);
    state.patch.mockRejectedValueOnce(new Error('response lost'));
    const signal = new AbortController().signal;
    await gateway.move({ userId: 'human', sourceId: 'a' }, moveInput(), signal);
    state.get.mockRejectedValueOnce(new Error('read unavailable'));
    expect(await gateway.move({ userId: 'human', sourceId: 'a' }, moveInput(), signal)).toMatchObject({ status: 'failed', reason: 'voice_state_unverified' });
    expect(state.patch).toHaveBeenCalledOnce();
  });
  it('scans fresh positions and discovers late arrivals without mutating relay cache', async () => {
    const state = discordHarness();
    const gateway = new DiscordMoveGateway(state.guild, state.rest);
    const snapshot = await gateway.snapshot('admin', ['a', 'b'], 'd');
    const input = { ...moveInput(), ...snapshot };
    state.positions.set('human', 'd');
    state.positions.set('leader', null);
    state.addMember('late', 'b');
    const result = await gateway.scan(input, new AbortController().signal);
    expect(result.remaining).toEqual([{ userId: 'late', sourceId: 'b' }]);
    expect(result.resolved).toEqual([
      { userId: 'human', status: 'skipped', reason: 'already_at_destination' },
      { userId: 'leader', status: 'skipped', reason: 'left_sources' },
    ]);
    expect(result.unverified).toEqual([]);
    expect(state.cache.get('human')!.channelId).toBe('a');
    expect(state.rawGuild.voiceStates.fetch).not.toHaveBeenCalled();
  });
  it('records unverified people instead of treating a failed read as an empty source', async () => {
    const state = discordHarness();
    const gateway = new DiscordMoveGateway(state.guild, state.rest);
    const input = { ...moveInput(), members: [{ userId: 'human', sourceId: 'a' }] };
    state.get.mockRejectedValueOnce(new Error('unavailable'));
    const result = await gateway.scan(input, new AbortController().signal);
    expect(result.unverified).toEqual(['human']);
    expect(result.remaining).toEqual([]);
    expect(result.resolved).toEqual([]);
  });
  it('preserves destination capacity across scans when gateway events lag', async () => {
    const state = discordHarness();
    state.channels.get('d')!.userLimit = 1;
    state.positions.set('human', 'd');
    const gateway = new DiscordMoveGateway(state.guild, state.rest);
    await gateway.scan({ ...moveInput(), members: [{ userId: 'human', sourceId: 'a' }] }, new AbortController().signal);
    expect(await gateway.move({ userId: 'leader', sourceId: 'b' }, { ...moveInput(), sources: [{ id: 'b', humans: 1, bots: 0 }] }, new AbortController().signal))
      .toMatchObject({ status: 'failed', reason: 'destination_full' });
    expect(state.patch).not.toHaveBeenCalled();
  });

});
