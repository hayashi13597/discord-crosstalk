import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, DiscordAPIError, PermissionFlagsBits, RateLimitError, type Interaction, type InteractionEditReplyOptions } from 'discord.js';
import { createVoiceMoveHandler } from '../src/voice-move-commands.js';
import { VoiceMoveService } from '../src/voice-moves.js';
import { commandDefinitions } from '../src/commands.js';
import { discordHarness, MemoryMoves } from './voice-move-helpers.js';

const closing: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closing.splice(0)) await close(); vi.useRealTimers(); });

function setup() {
  const discord = discordHarness();
  const repository = new MemoryMoves();
  const errors = vi.fn();
  const service = new VoiceMoveService(repository, errors);
  const handler = createVoiceMoveHandler({ guildId: 'guild', service, rest: discord.rest, onError: errors });
  closing.push(() => handler.stop());
  let panel: InteractionEditReplyOptions;
  const editReply = vi.fn(async (value: InteractionEditReplyOptions) => { panel = value; });
  const base = () => ({ guild: discord.guild, guildId: 'guild', user: { id: 'admin' }, deferred: false, replied: false,
    inGuild: () => true, isRepliable: () => true, isChatInputCommand: () => false,
    isButton: () => false, isChannelSelectMenu: () => false, isStringSelectMenu: () => false,
    reply: vi.fn(), editReply });
  const command = async (sub = 'move-all', job = '', guildId = 'guild', sourceChannels: Record<string, string> = { channel: job }) => {
    const value = { ...base(), guildId, commandName: 'voice', isChatInputCommand: () => true,
      options: { getSubcommand: () => sub, getString: () => job, getChannel: (name: string) => sourceChannels[name] ? { id: sourceChannels[name] } : null },
      deferReply: vi.fn(async () => { value.deferred = true; }) };
    await handler.handle(value as unknown as Interaction);
    return value;
  };
  const click = async (action: string, values?: string[], userId = 'admin', explicitId?: string) => {
    const value = { ...base(), user: { id: userId }, customId: explicitId ?? action, values,
      isButton: () => !values, isChannelSelectMenu: () => !!values,
      deferUpdate: vi.fn(async () => { value.deferred = true; }) };
    await handler.handle(value as unknown as Interaction);
    return value;
  };
  const configure = async (sourceIds = ['a', 'b'], destinationId = 'd') => {
    await repository.setSources('guild', sourceIds);
    await repository.setDestination('guild', destinationId);
  };
  return { ...discord, repository, errors, service, handler, command, click, configure, editReply, panel: () => panel };
}

describe('configured mass voice move', () => {
  it('registers configuration commands and parameterless move-all', () => {
    const command = commandDefinitions.find(command => command.name === 'voice')!;
    expect(command.dm_permission).toBe(false);
    expect(command.default_member_permissions).toBe(String(PermissionFlagsBits.MoveMembers | PermissionFlagsBits.ManageGuild));
    expect(command.options!.map(option => option.name)).toEqual(['move-all', 'set-sources', 'move-config', 'set-destination', 'move-status']);
    expect(command.options![0]).toHaveProperty('options', []);
    const sources = command.options!.find(option => option.name === 'set-sources')!;
    expect('options' in sources && sources.options).toEqual(Array.from({ length: 25 }, (_, index) =>
      expect.objectContaining({ name: index === 0 ? 'channel' : `channel-${index + 1}`,
        type: 7, channel_types: [ChannelType.GuildVoice], required: index === 0 })));

  });
  it('saves selected channels, deduplicates and replaces the list without moving anyone', async () => {
    const state = setup();
    const a = '123456789012345678', b = '123456789012345679';
    state.addChannel(a); state.addChannel(b);
    await state.command('set-sources', '', 'guild', { channel: a, 'channel-2': b, 'channel-3': a });
    expect((await state.repository.getSettings('guild')).sourceIds).toEqual([a, b]);
    await state.command('set-destination', 'd');
    await state.command('set-sources', b);
    expect(await state.repository.getSettings('guild')).toEqual({ sourceIds: [b], destinationId: 'd' });
    await state.command('move-config');
    expect(state.panel().content).toContain(`<#${b}>`);
    expect(state.panel().content).toContain('<#d>');
    expect(state.patch).not.toHaveBeenCalled();
  });
  it('does not replace saved sources when no channel is provided', async () => {
    const state = setup();
    await state.configure();
    await state.command('set-sources');
    expect(state.panel().content).toContain('Cần từ 1 đến 25');
    expect((await state.repository.getSettings('guild')).sourceIds).toEqual(['a', 'b']);
    expect(state.patch).not.toHaveBeenCalled();
  });
  it('accepts 25 channel selectors, including optional fields with gaps', async () => {
    const state = setup();
    const channels = Object.fromEntries(Array.from({ length: 25 }, (_, index) => {
      const id = `source${index}`;
      state.addChannel(id);
      return [index === 0 ? 'channel' : `channel-${index + 1}`, id];
    }));
    await state.command('set-sources', '', 'guild', channels);
    expect((await state.repository.getSettings('guild')).sourceIds).toEqual(Object.values(channels));
    await state.command('set-sources', '', 'guild', { channel: 'a', 'channel-25': 'b' });
    expect((await state.repository.getSettings('guild')).sourceIds).toEqual(['a', 'b']);
  });
  it('preserves saved sources if a later selected channel is invalid', async () => {
    const state = setup();
    await state.configure();
    state.channels.get('c')!.type = ChannelType.GuildStageVoice;
    await state.command('set-sources', '', 'guild', { channel: 'a', 'channel-2': 'c' });
    expect((await state.repository.getSettings('guild')).sourceIds).toEqual(['a', 'b']);
    expect(state.repository.setSources).toHaveBeenCalledOnce();
    expect(state.patch).not.toHaveBeenCalled();
  });
  it.each(['missing', 'stage', 'foreign', 'permission'])('rejects invalid settings: %s', async failure => {
    const state = setup();
    const id = '123456789012345678';
    state.addChannel(id);
    if (failure === 'missing') state.channels.delete(id);
    if (failure === 'stage') state.channels.get(id)!.type = ChannelType.GuildStageVoice;
    if (failure === 'foreign') state.channels.get(id)!.guildId = 'other';
    if (failure === 'permission') state.permissions.delete(PermissionFlagsBits.MoveMembers);
    await state.command('set-sources', id);
    await state.command('set-destination', id);
    expect(state.repository.setSources).not.toHaveBeenCalled();
    expect(state.repository.setDestination).not.toHaveBeenCalled();
    expect(state.patch).not.toHaveBeenCalled();
  });
  it('requires both sources and destination before moving', async () => {
    const state = setup();
    await state.command();
    expect(state.panel().content).toContain('Chưa đủ cấu hình');
    await state.repository.setDestination('guild', 'd');
    await state.command();
    expect(state.panel().content).toContain('/voice set-sources');
    expect(state.patch).not.toHaveBeenCalled();
  });
  it('runs immediately from a fresh snapshot without menus or confirmation', async () => {
    const state = setup();
    await state.configure();
    state.addMember('new-arrival', 'b');
    const command = await state.command();
    expect(command.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(state.patch).toHaveBeenCalledTimes(3);
    expect(state.repository.create).toHaveBeenCalledOnce();
    expect(state.repository.jobs.values().next().value!).toMatchObject({ status: 'Completed', destinationId: 'd', sources: [{ id: 'a' }, { id: 'b' }] });
    expect(state.cache.get('relay')!.channelId).toBe('a');
    expect(state.panel()).toMatchObject({ content: expect.stringContaining('Đã chuyển 3 người; bỏ qua 1.'), components: [] });
    expect(state.panel().content).toContain('Đã chuyển hết');
    expect(state.editReply.mock.calls.every(([reply]) => reply.components?.length === 0)).toBe(true);
  });
  it('keeps an active job configuration fixed while settings change and rejects competing runs', async () => {
    const state = setup();
    await state.configure();
    let release!: () => void;
    state.patch.mockImplementationOnce(() => new Promise(resolve => { release = () => { state.positions.set('human', 'd'); resolve({}); }; }));
    const first = state.command();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    try {
      await state.command();
      expect(state.panel().content).toContain('đang có một tác vụ');
      await state.configure(['c'], 'a');
    } finally { release(); await first; }
    const job = state.repository.jobs.values().next().value!;
    expect(job.destinationId).toBe('d');
    expect(job.sources.map(source => source.id)).toEqual(['a', 'b']);
    expect(state.repository.create).toHaveBeenCalledOnce();
    expect(state.patch).toHaveBeenCalledTimes(2);
  });
  it('leaves saved configuration intact when a settings write fails', async () => {
    const state = setup();
    await state.configure();
    const id = '123456789012345678';
    state.addChannel(id);
    state.repository.setSources.mockRejectedValueOnce(new Error('disk error'));
    await state.command('set-sources', id);
    expect(state.panel().content).toContain('Không thể thực hiện');
    expect(await state.repository.getSettings('guild')).toEqual({ sourceIds: ['a', 'b'], destinationId: 'd' });
    expect(state.patch).not.toHaveBeenCalled();
  });
  it('moves members from all 25 saved sources', async () => {
    const state = setup();
    const sources = Array.from({ length: 25 }, (_, i) => `source${i}`);
    for (const id of sources) { state.addChannel(id); state.addMember(`user-${id}`, id); }
    await state.configure(sources);
    await state.command();
    expect(state.patch).toHaveBeenCalledTimes(25);
  });
  it.each(['overlap', 'full', 'caller', 'bot', 'channel', 'database'])(
    'never moves if preflight fails: %s', async failure => {
      const state = setup();
      await state.configure(failure === 'empty' ? ['c'] : ['a', 'b'], failure === 'overlap' ? 'a' : 'd');
      if (failure === 'full') state.channels.get('d')!.userLimit = 1;
      if (failure === 'caller') state.permissions.delete(PermissionFlagsBits.MoveMembers);
      if (failure === 'bot') state.botPermissions.delete(PermissionFlagsBits.Connect);
      if (failure === 'channel') state.channels.delete('a');
      if (failure === 'database') state.repository.create.mockRejectedValueOnce(new Error('database offline'));
      await state.command();
      expect(state.panel().components).toEqual([]);
      expect(state.panel().content).not.toBe('Đang chuyển…');
      expect(state.patch).not.toHaveBeenCalled();
    });
  it('rejects old selection panels and foreign guilds', async () => {
    const state = setup();
    await state.configure();
    const old = await state.click('vm:old:0:confirm');
    expect(old.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Bảng chọn cũ') }));
    const foreign = await state.command('move-all', '', 'other');
    expect(foreign.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('server đã cấu hình') }));
    expect(state.patch).not.toHaveBeenCalled();
  });
  it('stops before moving if progress cannot be delivered', async () => {
    const state = setup();
    await state.configure();
    state.editReply.mockRejectedValueOnce(new Error('webhook unavailable'));
    await state.command();
    expect(state.patch).not.toHaveBeenCalled();
  });
  it.each(['permission', 'unknown', 'rate_limit'])('handles a %s error after one success', async failure => {
    const state = setup();
    state.addMember('remaining', 'b');
    await state.configure();
    const original = state.patch.getMockImplementation()!;
    state.patch.mockImplementationOnce(original).mockRejectedValueOnce(failure === 'permission'
      ? new DiscordAPIError({ code: 50013, message: 'missing permission' }, 50013, 403, 'PATCH', '/route', {})
      : failure === 'rate_limit'
        ? new RateLimitError({ timeToReset: 10, retryAfter: 10, sublimitTimeout: 0, limit: 1, method: 'PATCH',
          hash: 'hash', url: '/route', route: '/route', majorParameter: 'guild', global: false, scope: 'user' })
        : new Error('response lost'));
    await state.command();
    const job = state.repository.jobs.values().next().value!;
    if (failure === 'permission') {
      expect(state.patch).toHaveBeenCalledTimes(2);
      expect(job.status).toBe('Interrupted');
      expect(state.panel().content).toContain('Đã dừng:');
      expect(state.panel().content).not.toContain('Đã chuyển hết');
    } else {
      expect(job.status).toBe('Completed');
      expect(state.patch).toHaveBeenCalledTimes(4);
      expect(state.panel().content).toContain('Đã chuyển hết');
    }
    expect(state.panel().content).toContain(job.id);
  });
  it('retrieves durable results by guild and paginates without long Discord messages', async () => {
    const state = setup();
    await state.configure(); await state.command();
    const job = state.repository.jobs.values().next().value!;
    for (let index = 0; index < 100; index++) job.members.push({ userId: `${index}`.padStart(20, '1'), sourceId: '12345678901234567890', status: 'failed', reason: 'missing_permissions_or_channel' });
    await state.command('move-status', job.id);
    expect(state.panel().content).toContain(job.id);
    const json = JSON.parse(JSON.stringify(state.panel()));
    const next = json.components[0].components[1].custom_id as string;
    await state.click('unused', undefined, 'admin', next);
    expect(state.panel().content!.length).toBeLessThan(2000);
    await state.command('move-status', 'not-a-uuid');
    expect(state.panel().content).toContain('không hợp lệ');
  });
});
