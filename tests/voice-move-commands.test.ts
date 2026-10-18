import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionFlagsBits, type Interaction, type InteractionEditReplyOptions } from 'discord.js';
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
      isButton: () => !values, isChannelSelectMenu: () => !!values && action !== 'remove-page',
      isStringSelectMenu: () => !!values && action === 'remove-page',
      deferUpdate: vi.fn(async () => { value.deferred = true; }) };
    await handler.handle(value as unknown as Interaction);
    return value;
  };
  const preview = async (sources = ['a', 'b']) => {
    const opened = await command();
    await click('sources', sources); await click('add');
    await click('destination', ['d']); await click('preview');
    return opened;
  };
  return { ...discord, repository, errors, service, handler, command, click, customId, preview, editReply, panel: () => panel };
}

describe('mass voice move interactive panel', () => {
  it('registers a guild-only command with no required move-all parameters', () => {
    const command = commandDefinitions.find(command => command.name === 'voice')!;
    expect(command.dm_permission).toBe(false);
    expect(command.default_member_permissions).toBe(String(PermissionFlagsBits.MoveMembers | PermissionFlagsBits.ManageGuild));
    expect(command.options!.map(option => option.name)).toEqual(['move-all', 'move-status']);
    expect(command.options![0]).toHaveProperty('options', []);
  });
  it('defers privately, previews humans/bots, and moves exactly the confirmed snapshot once', async () => {
    const state = setup();
    const opened = await state.preview();
    expect(opened.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(state.panel().content).toContain('Tổng: 2 người; bỏ qua 1 bot');
    expect(state.panel().content).toContain('Đích hiện có 0 người/bot; không đặt giới hạn người');
    expect(state.patch).not.toHaveBeenCalled();
    const confirm = state.customId('confirm');
    await state.click('confirm');
    await state.click('confirm', undefined, 'admin', confirm);
    expect(state.patch).toHaveBeenCalledTimes(2);
    expect(state.repository.create).toHaveBeenCalledOnce();
    expect(state.repository.jobs.values().next().value!.status).toBe('Completed');
    expect(state.cache.get('relay')!.channelId).toBe('a');
  });
  it('accumulates more than 25 sources across batches without losing or duplicating channels', async () => {
    const state = setup();
    const channels = Array.from({ length: 32 }, (_, index) => `source${index}`);
    for (const id of channels) { state.addChannel(id); state.addMember(`user-${id}`, id); }
    await state.command();
    await state.click('sources', channels.slice(0, 25)); await state.click('add');
    await state.click('sources', [...channels.slice(20)]); await state.click('add');
    expect(state.panel().content).toContain('đã chọn 32 nguồn');
    await state.click('list');
    expect(state.panel().content).toContain('Trang 1/2');
    await state.click('next');
    expect(state.panel().content).toContain('<#source31>');
    await state.click('remove-page', ['source31']);
    await state.click('back');
    await state.click('destination', ['d']); await state.click('preview');
    expect(state.panel().content).toContain('Tổng: 31 người');
    await state.click('confirm');
    expect(state.patch).toHaveBeenCalledTimes(31);
    const job = state.repository.jobs.values().next().value!;
    expect(job.sources).toHaveLength(31);
    expect(job.members.some(member => member.sourceId === 'source31')).toBe(false);
  });
  it('supports staged removal, clearing, and returning from preview with a new snapshot', async () => {
    const state = setup();
    await state.preview();
    const stale = state.customId('confirm');
    await state.click('back');
    await state.click('sources', ['a']); await state.click('remove');
    state.addMember('new-arrival', 'b');
    await state.click('preview');
    expect(state.panel().content).toContain('Tổng: 2 người');
    await state.click('confirm', undefined, 'admin', stale);
    expect(state.patch).not.toHaveBeenCalled();
    await state.click('back'); await state.click('clear');
    expect(state.panel().content).toContain('đã chọn 0 nguồn');
  });
  it('rejects source=destination and pending uncommitted selections without losing the panel', async () => {
    const state = setup();
    await state.command(); await state.click('sources', ['a']); await state.click('add');
    await state.click('destination', ['a']); await state.click('preview');
    expect(state.panel().content).toContain('khác mọi nguồn');
    await state.click('destination', ['d']); await state.click('sources', ['b']); await state.click('preview');
    expect(state.panel().content).toContain('chưa thêm');
    expect(state.patch).not.toHaveBeenCalled();
  });
  it('refuses other users, foreign guilds, and stale component revisions', async () => {
    const state = setup();
    await state.preview();
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
      await state.preview();
      if (kind === 'caller') state.permissions.delete(PermissionFlagsBits.MoveMembers);
      else state.botPermissions.delete(PermissionFlagsBits.Connect);
      await state.click('confirm');
      expect(state.patch).not.toHaveBeenCalled();
      expect(state.repository.create).not.toHaveBeenCalled();
    }
  });
  it('cancels and expires both selecting and confirming sessions with durable audit and no moves', async () => {
    vi.useFakeTimers();
    const cancelled = setup();
    await cancelled.preview(); await cancelled.click('cancel');
    expect(cancelled.repository.jobs.values().next().value!.reason).toBe('user_cancelled');
    const selecting = setup(); await selecting.command();
    await vi.advanceTimersByTimeAsync(600001);
    expect(selecting.repository.jobs.values().next().value!.reason).toBe('session_expired');
    const confirming = setup(); await confirming.preview();
    const id = confirming.customId('confirm');
    await vi.advanceTimersByTimeAsync(60001);
    await confirming.click('confirm', undefined, 'admin', id);
    expect(confirming.repository.jobs.values().next().value!.status).toBe('Cancelled');
    expect(confirming.patch).not.toHaveBeenCalled();
  });
  it('locks a session across asynchronous confirmation to reject double clicks', async () => {
    const state = setup();
    await state.preview();
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
    await state.preview(); await state.click('confirm');
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
