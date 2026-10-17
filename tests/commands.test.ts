import { describe, expect, it, vi } from 'vitest';
import { PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import { createCommandHandler } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { LeaderService } from '../src/leaders.js';
import { emptyLeaders, UserError } from '../src/types.js';

const env = {
  GUILD_ID: '123456789012345678', BOT_TOKEN_1: 'a', BOT_TOKEN_2: 'b', BOT_TOKEN_3: 'c',
  VOICE_CHANNEL_ID_1: '123456789012345671', VOICE_CHANNEL_ID_2: '123456789012345672', VOICE_CHANNEL_ID_3: '123456789012345673',
  DATABASE_URL: 'postgresql://localhost/test',
};
function setup({ allowed = true, bot = false, guildId = env.GUILD_ID, role = false, sub = 'set', team = 1 } = {}) {
  const config = loadConfig({ ...env, ADMIN_ROLE_IDS: role ? '123456789012345679' : '' });
  const change = vi.fn().mockResolvedValue({ 1: 'alice', 2: null, 3: null });
  const service = new LeaderService({ load: async () => emptyLeaders(), change, healthy: async () => true }, () => {});
  const member = { id: 'alice', user: { bot }, voice: { channelId: null } };
  const actor = { id: 'admin', permissions: { has: vi.fn(() => allowed) }, roles: { cache: new Map(role ? [['123456789012345679', {}]] : []) } };
  const fetch = vi.fn(async ({ user }: { user: string }) => user === 'admin' ? actor : member);
  const interaction = {
    commandName: 'leader', guildId, inGuild: () => true, user: { id: 'admin' }, guild: { members: { fetch } },
    deferred: false, replied: false,
    options: { getSubcommand: () => sub, getInteger: () => team, getUser: () => ({ id: 'alice' }) },
    deferReply: vi.fn(async () => { interaction.deferred = true; }),
    editReply: vi.fn(), reply: vi.fn(),
  };
  const onError = vi.fn();
  const handler = createCommandHandler({ config, leaders: service, status: async () => 'healthy', onError });
  const run = () => handler.handle(interaction as unknown as ChatInputCommandInteraction);
  return { interaction, run, change, actor, fetch, onError, handler };
}
describe('slash commands', () => {
  it('checks current permissions on each mutation and refuses ordinary members', async () => {
    const { run, fetch, change, interaction, actor } = setup({ allowed: false });
    await run();
    expect(fetch).toHaveBeenCalledWith({ user: 'admin', force: true });
    expect(actor.permissions.has).toHaveBeenCalledWith(PermissionFlagsBits.ManageGuild);
    expect(change).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Manage Server') }));
  });
  it.each([{ allowed: true }, { allowed: false, role: true }])('allows configured administrators %j and explains wrong-channel assignment', async options => {
    const { run, change, interaction } = setup(options);
    await run();
    expect(change).toHaveBeenCalledWith(1, 'alice', 'admin');
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('đúng voice channel') }));
  });
  it('rejects bots', async () => {
    const { run, change } = setup({ bot: true });
    await run();
    expect(change).not.toHaveBeenCalled();
  });
  it('rejects non-members and duplicate leaders', async () => {
    const missing = setup();
    missing.fetch.mockRejectedValueOnce(Object.assign(new Error('Unknown Member'), { code: 10007 }));
    await missing.run();
    expect(missing.change).not.toHaveBeenCalled();
    const duplicate = setup();
    duplicate.change.mockRejectedValue(new UserError('Hãy gỡ phân công cũ trước.'));
    await duplicate.run();
    expect(duplicate.interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('phân công cũ') }));
  });
  it('removes the leader through the persisted service', async () => {
    const { run, change } = setup({ sub: 'remove' });
    await run();
    expect(change).toHaveBeenCalledWith(1, null, 'admin');
  });
  it('allows list/show/status without mutation permissions', async () => {
    const list = setup({ allowed: false, sub: 'list' });
    await list.run();
    expect(list.fetch).not.toHaveBeenCalled();
    expect(list.interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Team 3: Chưa có leader') }));
    const show = setup({ allowed: false, sub: 'show' });
    await show.run();
    expect(show.change).not.toHaveBeenCalled();
    const status = setup({ allowed: false });
    status.interaction.commandName = 'status';
    await status.run();
    expect(status.interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: 'healthy' }));
  });
  it.each([{ guildId: 'wrong-guild' }, { team: 4 }])('refuses invalid context %j', async options => {
    const { run, change } = setup(options);
    await run();
    expect(change).not.toHaveBeenCalled();
  });
  it('does not expose persistence errors or accept new commands after shutdown', async () => {
    const { run, change, interaction, handler, onError } = setup();
    change.mockRejectedValue(new Error('database secret/password'));
    await run();
    expect(onError).toHaveBeenCalled();
    expect(JSON.stringify(interaction.editReply.mock.calls)).not.toContain('secret/password');
    handler.stop();
    await run();
    expect(change).toHaveBeenCalledTimes(1);
  });
});
