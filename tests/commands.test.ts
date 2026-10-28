import { describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits, type Interaction } from 'discord.js';
import { commandDefinitions, createCommandHandler, paginate } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { RelayService } from '../src/relays.js';
import { type LeaderPresence, type RelaySnapshot } from '../src/types.js';

const env = {
  GUILD_ID: '123456789012345678', LEADER_ROLE_ID: '123456789012345680', BOT_TOKEN_1: 'a', BOT_TOKEN_2: 'b', BOT_TOKEN_3: 'c',
};
const initial: RelaySnapshot = {
  groups: [{ id: 'a', name: 'Group A', state: 'active', legacy: true }, { id: 'b', name: 'Bravo', state: 'paused', legacy: false }],
  teams: [
    { id: 'a1', groupId: 'a', channelId: '123456789012345671', workerId: 1 },
    { id: 'b1', groupId: 'b', channelId: '123456789012345674', workerId: 4 },
  ],
};
async function setup({ allowed = true, bot = false, role = false, command = 'leader', sub = 'show',
  channel = initial.teams[0]!.channelId as string | null, group = null as string | null, guildId = env.GUILD_ID } = {}) {
  const config = loadConfig({ ...env, ADMIN_ROLE_IDS: role ? '123456789012345679' : '' });
  const mutate = vi.fn(async () => structuredClone(initial));
  const relays = new RelayService({ initialize: async () => structuredClone(initial), mutate, identify: async () => {}, healthy: async () => true }, () => {}, vi.fn());
  await relays.initialize();
  const member = { id: 'alice', user: { bot }, voice: { channelId: null } };
  const actor = { id: 'admin', permissions: { has: vi.fn(() => allowed) }, roles: { cache: new Map(role ? [['123456789012345679', {}]] : []) } };
  const fetch = vi.fn(async ({ user }: { user: string }) => user === 'admin' ? actor : member);
  const interaction = {
    commandName: command, guildId, inGuild: () => true, user: { id: 'admin' }, guild: { members: { fetch }, channels: { fetch: vi.fn(async () => ({ type: ChannelType.GuildVoice, guildId })) } },
    deferred: false, replied: false,
    isButton: () => false, isAutocomplete: () => false, isChatInputCommand: () => true, isRepliable: () => true,
    options: { getSubcommand: () => sub, getChannel: () => channel ? { id: channel } : null,
      getString: (key: string) => key === 'name' ? 'Charlie' : group, getUser: () => ({ id: 'alice' }) },
    deferReply: vi.fn(async () => { interaction.deferred = true; }), editReply: vi.fn(), reply: vi.fn(),
  };
  const onError = vi.fn();
  const status = vi.fn(async (_id?: string) => 'healthy');
  const leaders = vi.fn<(team: RelaySnapshot['teams'][number]) => LeaderPresence | undefined>(team => ({
    leadersKnown: true, leaderIds: team.id === 'b1' ? ['carol', 'dave'] : [],
  }));
  const setSession = vi.fn();
  const handler = createCommandHandler({ config, relays, status, leaders, onError, setSession });
  const run = () => handler.handle(interaction as unknown as Interaction);
  const button = (customId: string) => {
    const value = { ...interaction, customId, deferred: false, replied: false, isButton: () => true, isChatInputCommand: () => false,
      deferUpdate: vi.fn(async () => { value.deferred = true; }), update: vi.fn(), editReply: vi.fn(), reply: vi.fn() };
    return { value, run: () => handler.handle(value as unknown as Interaction) };
  };
  const confirmId = () => interaction.editReply.mock.calls.at(-1)![0].components[0].components[0].data.custom_id as string;
  return { interaction, run, mutate, actor, fetch, member, onError, handler, relays, status, leaders, button, confirmId, setSession };
}

describe('multi-group slash commands', () => {
  it('serializes valid command definitions with channel selectors and group autocomplete', () => {
    expect(commandDefinitions.map(command => command.name)).toEqual(['help', 'start', 'stop', 'group', 'team', 'leader', 'status', 'voice']);
    const text = JSON.stringify(commandDefinitions);
    expect(text).toContain('autocomplete');
    expect(text).toContain('channel');
    expect(text).toContain('team');
    const leader = commandDefinitions.find(command => command.name === 'leader')!;
    expect(leader.options!.map(option => option.name)).toEqual(['list', 'show']);
    const show = leader.options!.find(option => option.name === 'show')!;
    expect('options' in show && show.options).toEqual([expect.objectContaining({ name: 'channel', required: true })]);
  });
  it('shows the full help to ordinary members with working pagination', async () => {
    const state = await setup({ command: 'help', allowed: false });
    state.interaction.options.getSubcommand = () => { throw new Error('Help has no subcommand'); };
    await state.run();
    let reply = state.interaction.editReply.mock.calls.at(-1)![0];
    const contents = [reply.content];
    for (let page = 0; page < 10; page++) {
      const next = reply.components[0]?.components[1]?.data;
      if (!next || next.disabled) break;
      const click = state.button(next.custom_id);
      await click.run();
      reply = click.value.update.mock.calls.at(-1)![0];
      contents.push(reply.content);
    }
    const text = contents.join('\n');
    for (const command of ['/help', '/start', '/stop', '/status', '/group create', '/group list', '/group info', '/group pause', '/group resume', '/group delete', '/team add', '/team remove', '/team list', '/leader list', '/leader show', '/voice move-all', '/voice move-status']) {
      expect(text).toContain(command);
    }
    expect(text).toContain('Move Members');
    expect(text).toContain('restart luôn chờ /start');
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.setSession).not.toHaveBeenCalled();
    expect(state.onError).not.toHaveBeenCalled();
  });
  it.each(['start', 'stop'])('authorizes /%s without requiring a subcommand', async command => {
    const state = await setup({ command });
    await state.run();
    expect(state.setSession).toHaveBeenCalledWith(command === 'start');
    expect(state.fetch).toHaveBeenCalledWith({ user: 'admin', force: true });
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it.each(['start', 'stop'])('refuses /%s for ordinary members', async command => {
    const state = await setup({ command, allowed: false });
    await state.run();
    expect(state.setSession).not.toHaveBeenCalled();
  });
  it('checks fresh permissions for mutations and refuses ordinary members', async () => {
    const { run, fetch, mutate, interaction, actor } = await setup({ command: 'group', sub: 'create', allowed: false });
    await run();
    expect(fetch).toHaveBeenCalledWith({ user: 'admin', force: true });
    expect(actor.permissions.has).toHaveBeenCalledWith(PermissionFlagsBits.ManageGuild);
    expect(mutate).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Manage Server') }));
  });
  it.each([{ allowed: true }, { allowed: false, role: true }])('allows channel-based leader inspection %j', async options => {
    const { run, mutate, interaction } = await setup(options);
    await run();
    expect(mutate).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Chưa có leader trong voice') }));
  });
  it('shows all live leaders in Group B instead of persisted assignments', async () => {
    const { run, mutate, interaction } = await setup({ channel: initial.teams[1]!.channelId });
    await run();
    expect(mutate).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('<@carol>, <@dave>') }));
    expect(JSON.stringify(interaction.editReply.mock.calls)).not.toContain('<@bob>');
  });
  it('distinguishes unknown leader state from an empty channel', async () => {
    const state = await setup();
    state.leaders.mockReturnValue(undefined);
    await state.run();
    expect(state.interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Chưa xác minh') }));
  });
  it.each([{ channel: 'unassigned' }, { channel: null }, { guildId: 'wrong' }])('refuses invalid target/context %j', async options => {
    const { run, mutate, interaction } = await setup(options);
    await run();
    expect(mutate).not.toHaveBeenCalled();
    expect(interaction.editReply.mock.calls.length + interaction.reply.mock.calls.length).toBe(1);
  });
  it('requires confirmation and fresh permissions to remove a team', async () => {
    const state = await setup({ command: 'team', sub: 'remove', channel: initial.teams[0]!.channelId });
    await state.run();
    expect(state.mutate).not.toHaveBeenCalled();
    const click = state.button(state.confirmId());
    await click.run();
    expect(state.actor.permissions.has).toHaveBeenCalledTimes(2);
    expect(state.mutate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'team.remove', teamId: 'a1', expected: expect.any(String) }), 'admin');
    await click.run();
    expect(state.mutate).toHaveBeenCalledTimes(1);
  });
  it('rejects expired confirmations, other users, and revoked permissions', async () => {
    const state = await setup({ command: 'team', sub: 'remove', channel: initial.teams[0]!.channelId });
    await state.run();
    const id = state.confirmId();
    const other = state.button(id);
    other.value.user = { id: 'stranger' };
    await other.run();
    expect(state.mutate).not.toHaveBeenCalled();
    state.actor.permissions.has.mockReturnValue(false);
    await state.button(id).run();
    expect(state.mutate).not.toHaveBeenCalled();
    state.actor.permissions.has.mockReturnValue(true);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
    try { await state.button(id).run(); expect(state.mutate).not.toHaveBeenCalled(); }
    finally { now.mockRestore(); }
  });
  it('cancels deletion without mutating configuration', async () => {
    const state = await setup({ command: 'team', sub: 'remove', channel: initial.teams[0]!.channelId });
    await state.run();
    await state.button(state.confirmId().replace('confirm', 'cancel')).run();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('protects Group A and confirms deletion of Group B', async () => {
    const a = await setup({ command: 'group', sub: 'delete', group: 'a' });
    await a.run();
    expect(a.interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Không được xóa Group A') }));
    const b = await setup({ command: 'group', sub: 'delete', group: 'b' });
    await b.run();
    await b.button(b.confirmId()).run();
    expect(b.mutate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'group.delete', groupId: 'b' }), 'admin');
  });
  it.each(['create', 'pause', 'resume'])('persists group %s', async sub => {
    const state = await setup({ command: 'group', sub, group: 'b' });
    await state.run();
    expect(state.mutate).toHaveBeenCalledWith(sub === 'create' ? { kind: 'group.create', name: 'Charlie' }
      : { kind: 'group.state', groupId: 'b', state: sub === 'pause' ? 'paused' : 'active' }, 'admin');
  });
  it('validates voice channels before adding a team and confirms removal', async () => {
    const added = await setup({ command: 'team', sub: 'add', group: 'b', channel: 'new' });
    await added.run();
    expect(added.mutate).toHaveBeenCalledWith({ kind: 'team.add', groupId: 'b', channelId: 'new' }, 'admin');
    const removed = await setup({ command: 'team', sub: 'remove', channel: initial.teams[1]!.channelId });
    await removed.run();
    await removed.button(removed.confirmId()).run();
    expect(removed.mutate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'team.remove', teamId: 'b1' }), 'admin');
  });
  it('defaults leader list to Group A and supports Group B filtering', async () => {
    const a = await setup({ sub: 'list', allowed: false });
    await a.run();
    expect(a.fetch).not.toHaveBeenCalled();
    expect(a.interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Group A\n<#123456789012345671>: Chưa có leader trong voice' }));
    const b = await setup({ sub: 'list', group: 'b', allowed: false });
    await b.run();
    expect(b.interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('<@carol>, <@dave>') }));
  });
  it.each([{ command: 'status', sub: '' }, { command: 'group', sub: 'info' }, { command: 'group', sub: 'list' }, { command: 'team', sub: 'list' }, { command: 'leader', sub: 'show' }])('allows inspection without mutation permissions %j', async options => {
    const state = await setup({ ...options, group: 'b', allowed: false });
    await state.run();
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.onError).not.toHaveBeenCalled();
  });
  it('autocompletes stable group IDs', async () => {
    const state = await setup({ command: 'group' });
    const respond = vi.fn();
    await state.handler.handle({ ...state.interaction, isAutocomplete: () => true, options: { getFocused: () => 'br' }, respond } as unknown as Interaction);
    expect(respond).toHaveBeenCalledWith([{ name: 'Bravo', value: 'b' }]);
  });
  it('paginates long responses using actor-bound navigation buttons', async () => {
    const state = await setup({ command: 'status' });
    state.status.mockResolvedValue(Array.from({ length: 100 }, (_, index) => `Team ${index}: ${'x'.repeat(80)}`).join('\n'));
    await state.run();
    const message = state.interaction.editReply.mock.calls[0]![0];
    expect(message.content.length).toBeLessThan(2000);
    const id = message.components[0].components[1].data.custom_id;
    const click = state.button(id);
    await click.run();
    expect(click.value.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Trang 2/') }));
    expect(paginate('x'.repeat(10000)).every(page => page.length <= 1800)).toBe(true);
  });
  it('hides persistence errors and rejects commands after shutdown', async () => {
    const state = await setup({ command: 'group', sub: 'create' });
    state.mutate.mockRejectedValue(new Error('database secret/password'));
    await state.run();
    expect(state.onError).toHaveBeenCalled();
    expect(JSON.stringify(state.interaction.editReply.mock.calls)).not.toContain('secret/password');
    state.handler.stop();
    await state.run();
    expect(state.mutate).toHaveBeenCalledTimes(1);
  });
});
