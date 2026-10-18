import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordAPIError, PermissionFlagsBits, RateLimitError, type Interaction, type InteractionEditReplyOptions } from 'discord.js';
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
  const command = async (sub = 'move-all', job = '', guildId = 'guild') => {
    const value = { ...base(), guildId, commandName: 'voice', isChatInputCommand: () => true,
      options: { getSubcommand: () => sub, getString: () => job },
      deferReply: vi.fn(async () => { value.deferred = true; }) };
    await handler.handle(value as unknown as Interaction);
    return value;
  };
  const customId = (action: string) => {
    const json = JSON.parse(JSON.stringify(panel));
    const ids = json.components.flatMap((row: { components: { custom_id: string }[] }) => row.components.map(value => value.custom_id)) as string[];
    const id = ids.find(id => id.endsWith(`:${action}`));
    if (!id) throw new Error(`No ${action} in ${JSON.stringify(json)}`);
    return id;
  };
  const click = async (action: string, values?: string[], userId = 'admin', explicitId?: string) => {
    const value = { ...base(), user: { id: userId }, customId: explicitId ?? customId(action), values,
      isButton: () => !values, isChannelSelectMenu: () => !!values,
      deferUpdate: vi.fn(async () => { value.deferred = true; }) };
    await handler.handle(value as unknown as Interaction);
    return value;
  };
  const select = async (sources = ['a', 'b']) => {
    const opened = await command();
    await click('sources', sources);
    await click('destination', ['d']);
    return opened;
  };
  return { ...discord, repository, errors, service, handler, command, click, customId, select, editReply, panel: () => panel };
}

describe('mass voice move interactive panel', () => {
  it('registers a guild-only command with no required move-all parameters', () => {
    const command = commandDefinitions.find(command => command.name === 'voice')!;
    expect(command.dm_permission).toBe(false);
    expect(command.default_member_permissions).toBe(String(PermissionFlagsBits.MoveMembers | PermissionFlagsBits.ManageGuild));
    expect(command.options!.map(option => option.name)).toEqual(['move-all', 'move-status']);
    expect(command.options![0]).toHaveProperty('options', []);
  });
  it('shows only two voice menus and confirm/cancel, enabling confirmation after both selections', async () => {
    const state = setup();
    const opened = await state.command();
    expect(opened.deferReply).toHaveBeenCalledWith({ flags: 64 });
    const panel = () => JSON.parse(JSON.stringify(state.panel()));
    expect(panel().content).toBe('Mass Voice Move');
    expect(panel().components).toHaveLength(3);
    expect(panel().components.slice(0, 2).map((row: { components: unknown[] }) => row.components.length)).toEqual([1, 1]);
    const menus = panel().components.slice(0, 2).map((row: { components: unknown[] }) => row.components[0]);
    expect(menus).toEqual([
      expect.objectContaining({ type: 8, channel_types: [2], placeholder: 'Voice nguồn', min_values: 1, max_values: 25 }),
      expect.objectContaining({ type: 8, channel_types: [2], placeholder: 'Voice đích', min_values: 1, max_values: 1 }),
    ]);
    expect(panel().components[2].components.map((button: { label: string }) => button.label)).toEqual(['Xác nhận', 'Hủy']);
    expect(panel().components[2].components[0].disabled).toBe(true);
    await state.click('sources', ['a']);
    expect(panel().components[2].components[0].disabled).toBe(true);
    await state.click('destination', ['d']);
    expect(panel().components[2].components[0].disabled).toBe(false);
    expect(state.patch).not.toHaveBeenCalled();
  });
  it('takes a fresh snapshot on confirmation and runs exactly once without a preview', async () => {
    const state = setup();
    await state.select();
    state.addMember('new-arrival', 'b');
    expect(state.repository.create).not.toHaveBeenCalled();
    const confirm = state.customId('confirm');
    await state.click('confirm');
    expect(state.panel()).toEqual(expect.objectContaining({ content: 'Đã chuyển 3 người; bỏ qua 1.', components: [] }));
    await state.click('confirm', undefined, 'admin', confirm);
    expect(state.patch).toHaveBeenCalledTimes(3);
    expect(state.repository.create).toHaveBeenCalledOnce();
    expect(state.repository.jobs.values().next().value!.status).toBe('Completed');
    expect(state.cache.get('relay')!.channelId).toBe('a');
  });
  it('replaces selections directly and moves members from all 25 selected sources', async () => {
    const state = setup();
    const channels = Array.from({ length: 25 }, (_, index) => `source${index}`);
    for (const id of channels) { state.addChannel(id); state.addMember(`user-${id}`, id); }
    await state.select();
    await state.click('sources', channels);
    const json = JSON.parse(JSON.stringify(state.panel()));
    expect(json.components[0].components[0].default_values.map((value: { id: string }) => value.id)).toEqual(channels);
    await state.click('destination', ['c']);
    await state.click('confirm');
    expect(state.patch).toHaveBeenCalledTimes(25);
    const job = state.repository.jobs.values().next().value!;
    expect(job.sources.map(source => source.id)).toEqual(channels);
    expect(job.destinationId).toBe('c');
    expect(job.members.some(member => ['a', 'b'].includes(member.sourceId))).toBe(false);
  });
  it('rejects more than 25 sources without replacing the previous selection', async () => {
    const state = setup();
    await state.select(['a']);
    await state.click('sources', Array.from({ length: 26 }, (_, index) => `source${index}`));
    expect(state.panel().content).toContain('Lựa chọn không hợp lệ');
    await state.click('confirm');
    expect(state.patch).toHaveBeenCalledOnce();
    expect(state.repository.jobs.values().next().value!.sources.map(source => source.id)).toEqual(['a']);
  });
  it.each(['overlap', 'empty', 'full', 'caller', 'bot', 'channel', 'database'])(
    'closes confirmation after %s errors and never starts a move', async failure => {
      const state = setup();
      await state.select();
      if (failure === 'overlap') await state.click('destination', ['a']);
      if (failure === 'empty') await state.click('sources', ['c']);
      if (failure === 'full') state.channels.get('d')!.userLimit = 1;
      if (failure === 'caller') state.permissions.delete(PermissionFlagsBits.MoveMembers);
      if (failure === 'bot') state.botPermissions.delete(PermissionFlagsBits.Connect);
      if (failure === 'channel') state.channels.delete('a');
      if (failure === 'database') state.repository.create.mockRejectedValueOnce(new Error('database offline'));
      const confirm = state.customId('confirm');
      await state.click('confirm');
      expect(state.panel().components).toEqual([]);
      expect(state.panel().content).not.toBe('Đang chuyển…');
      expect(state.patch).not.toHaveBeenCalled();
      const stale = await state.click('confirm', undefined, 'admin', confirm);
      expect(stale.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Phiên đã hết hạn hoặc đã xử lý') }));
      expect(state.patch).not.toHaveBeenCalled();
    },
  );
  it.each(['permission', 'unknown', 'rate_limit'])('stops on a %s error after one success and shows a compact error', async failure => {
    const state = setup();
    state.addMember('remaining', 'b');
    await state.select();
    const error = failure === 'permission'
      ? new DiscordAPIError({ code: 50013, message: 'missing permission' }, 50013, 403, 'PATCH', '/route', {})
      : failure === 'rate_limit'
        ? new RateLimitError({ timeToReset: 1500, retryAfter: 1500, sublimitTimeout: 0, limit: 1, method: 'PATCH',
          hash: 'hash', url: '/route', route: '/route', majorParameter: 'guild', global: false, scope: 'user' })
        : new Error('response lost');
    state.patch.mockResolvedValueOnce({}).mockRejectedValueOnce(error);
    await state.click('confirm');
    expect(state.patch).toHaveBeenCalledTimes(2);
    const job = state.repository.jobs.values().next().value!;
    expect(job.status).toBe('Interrupted');
    expect(job.members.map(member => member.status)).toEqual(['moved', failure === 'unknown' ? 'unknown' : 'failed', 'failed']);
    expect(state.panel().components).toEqual([]);
    expect(state.panel().content).toContain('Đã dừng:');
    expect(state.panel().content).toContain('Đã chuyển 1 người');
    expect(state.panel().content).toContain(job.id);
  });
  it('refuses other users, foreign guilds, and stale component revisions', async () => {
    const state = setup();
    await state.select();
    const confirm = state.customId('confirm');
    const outsider = await state.click('confirm', undefined, 'stranger', confirm);
    expect(outsider.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Chỉ người gọi') }));
    expect(state.patch).not.toHaveBeenCalled();
    const foreign = await state.command('move-all', '', 'other-guild');
    expect(foreign.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('server đã cấu hình') }));
  });
  it('requires fresh caller and bot permissions at confirmation', async () => {
    for (const kind of ['caller', 'bot']) {
      const state = setup();
      await state.select();
      if (kind === 'caller') state.permissions.delete(PermissionFlagsBits.MoveMembers);
      else state.botPermissions.delete(PermissionFlagsBits.Connect);
      await state.click('confirm');
      expect(state.patch).not.toHaveBeenCalled();
      expect(state.repository.create).not.toHaveBeenCalled();
    }
  });
  it('cancels and expires sessions with durable audit and no moves', async () => {
    vi.useFakeTimers();
    const cancelled = setup();
    await cancelled.select(); await cancelled.click('cancel');
    expect(cancelled.repository.jobs.values().next().value!.reason).toBe('user_cancelled');
    expect(cancelled.panel()).toEqual(expect.objectContaining({ content: 'Đã hủy.', components: [] }));
    const selecting = setup(); await selecting.command();
    const selected = setup(); await selected.select();
    const id = selected.customId('confirm');
    await vi.advanceTimersByTimeAsync(600001);
    expect(selecting.repository.jobs.values().next().value!.reason).toBe('session_expired');
    expect(selected.repository.jobs.values().next().value!.reason).toBe('session_expired');
    expect(selecting.panel().components).toEqual([]);
    expect(selected.panel().components).toEqual([]);
    await selected.click('confirm', undefined, 'admin', id);
    expect(selected.patch).not.toHaveBeenCalled();
  });
  it('keeps a selected panel valid beyond 60 seconds and rejects stale revisions', async () => {
    vi.useFakeTimers();
    const state = setup();
    await state.select();
    const stale = state.customId('confirm');
    await state.click('sources', ['a']);
    await state.click('confirm', undefined, 'admin', stale);
    expect(state.patch).not.toHaveBeenCalled();
    expect(state.panel().components).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(61000);
    await state.click('confirm');
    expect(state.patch).toHaveBeenCalledOnce();
  });
  it('stops if the session expires while building the confirmation snapshot', async () => {
    vi.useFakeTimers();
    const state = setup();
    await state.select();
    await vi.advanceTimersByTimeAsync(599999);
    const fetch = state.rawGuild.members.fetch.getMockImplementation()!;
    state.rawGuild.members.fetch.mockImplementation(async options => {
      if (options.user === 'human') vi.setSystemTime(Date.now() + 2);
      return fetch(options);
    });
    await state.click('confirm');
    expect(state.patch).not.toHaveBeenCalled();
    expect(state.panel().components).toEqual([]);
    expect(state.panel().content).toContain('hết hạn');
  });
  it('stops before any move if the starting message fails', async () => {
    const state = setup();
    await state.select();
    state.editReply.mockRejectedValueOnce(new Error('webhook unavailable'));
    await state.click('confirm');
    expect(state.patch).not.toHaveBeenCalled();
    expect(state.panel().components).toEqual([]);
  });
  it('locks a session across asynchronous confirmation to reject double clicks', async () => {
    const state = setup();
    await state.select();
    const id = state.customId('confirm');
    let release!: () => void;
    state.rawGuild.roles.fetch.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(new Map()); }));
    const first = state.click('confirm', undefined, 'admin', id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await state.click('confirm', undefined, 'admin', id);
    release(); await first;
    expect(state.repository.create).toHaveBeenCalledOnce();
    expect(state.patch).toHaveBeenCalledTimes(2);
  });
  it('retrieves durable results by guild and paginates without long Discord messages', async () => {
    const state = setup();
    await state.select(); await state.click('confirm');
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
