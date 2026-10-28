import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioRouter, FRAME_BYTES } from '../src/audio/router.js';
import { loadConfig } from '../src/config.js';
import { TeamBot, type WorkerOptions } from '../src/bot.js';
import { registerCommands } from '../src/commands.js';
import { Events, GatewayIntentBits, type Client, type Interaction } from 'discord.js';
import type { Logger } from 'pino';

const mocks = vi.hoisted(() => ({ join: vi.fn(), enter: vi.fn(), codecClosed: vi.fn() }));
vi.mock('../src/commands.js', () => ({ registerCommands: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/audio/codec.js', () => ({ createCodec: () => ({
  encode: (pcm: Buffer) => pcm, decode: () => Buffer.alloc(3840), close: mocks.codecClosed,
}) }));
vi.mock('@discordjs/voice', async importOriginal => {
  const original = await importOriginal<typeof import('@discordjs/voice')>();
  return { ...original, joinVoiceChannel: mocks.join, entersState: mocks.enter };
});
vi.mock('discord.js', async importOriginal => {
  const original = await importOriginal<typeof import('discord.js')>();
  const { EventEmitter } = await import('node:events');
  class MockClient extends EventEmitter {
    constructor(public options: unknown) { super(); }
    ready = false;
    destroyed = false;
    user = { id: 'bot1' };
    application = { id: 'bot1' };
    users = { cache: new Map([['alice', { id: 'alice', bot: false }], ['bob', { id: 'bob', bot: false }]]) };
    guilds = { cache: new Map(), fetch: vi.fn() };
    isReady() { return !this.destroyed && this.ready; }
    login = vi.fn(async () => {
      if (!this.destroyed) {
        this.ready = true;
        this.emit(original.Events.ClientReady, this);
      }
      return 'token';
    });
    destroy = vi.fn(async () => { this.destroyed = true; this.ready = false; });
  }
  return { ...original, Client: MockClient };
});

const config = loadConfig({
  GUILD_ID: '123456789012345678', LEADER_ROLE_ID: '123456789012345680', BOT_TOKEN_1: 'a', BOT_TOKEN_2: 'b', BOT_TOKEN_3: 'c',
});
const channels = { 1: '123456789012345671', 2: '123456789012345672', 3: '123456789012345673' };
const activeBots: TeamBot[] = [];
afterEach(async () => {
  await Promise.all(activeBots.splice(0).map(bot => bot.stop()));
  vi.useRealTimers();
  vi.clearAllMocks();
});

function setup(onInteraction?: ConstructorParameters<typeof TeamBot>[4], options?: WorkerOptions) {
  vi.useFakeTimers();
  const router = new AudioRouter({ 1: channels[1], 2: channels[2], 3: channels[3] }, config);
  const bot = new TeamBot(1, config, router, { info: vi.fn(), warn: vi.fn() } as unknown as Logger, onInteraction, options ?? { workerId: 1, token: config.workers[0]!.token, channelId: channels[1], active: true, onIdentity: vi.fn(async () => {}) });
  activeBots.push(bot);
  const voice = { channelId: channels[1], serverDeaf: false, serverMute: false };
  const members = new Map(['alice', 'bob', 'relay-bot'].map(id => [id, {
    id, user: { bot: id === 'relay-bot' }, guild: { id: config.guildId },
    voice: { channelId: channels[1] },
    roles: { cache: new Map(id === 'alice' || id === 'relay-bot' ? [[config.leaderRoleId, {}]] : []) },
  }]));
  const state = (id: string, channelId = channels[1]) => ({ id, channelId, member: members.get(id)! });
  const states = new Map(['alice', 'bob', 'relay-bot'].map(id => [id, state(id)]));
  const me = { voice };
  const guild = { id: config.guildId, members: { me, cache: members, fetchMe: vi.fn(async () => me),
      fetch: vi.fn(async ({ user }: { user: string }) => members.get(user)) },
    roles: { fetch: vi.fn(async () => ({ id: config.leaderRoleId })) },
    channels: { fetch: vi.fn(async () => ({ id: channels[1], type: 2, permissionsFor: () => ({ has: () => true }) })) },
    voiceStates: { cache: states }, voiceAdapterCreator: vi.fn(),
  };
  const configureClient = () => {
    bot.client.guilds.cache.set(config.guildId, guild as never);
    vi.mocked(bot.client.guilds.fetch).mockResolvedValue(guild as never);
  };
  configureClient();
  const subscriptions = new Map<string, PassThrough>();
  const subscribe = vi.fn((userId: string) => {
    const stream = new PassThrough({ objectMode: true });
    subscriptions.set(userId, stream);
    stream.once('close', () => subscriptions.delete(userId));
    return stream;
  });
  const connection = Object.assign(new EventEmitter(), {
    state: { status: 'ready' }, joinConfig: { channelId: channels[1] }, receiver: { subscriptions, subscribe },
    subscribe: vi.fn(), destroy: vi.fn(() => { connection.state.status = 'destroyed'; }),
  });
  mocks.join.mockReturnValue(connection);
  mocks.enter.mockImplementation(async () => {
    const old = connection.state;
    connection.state = { status: 'ready' };
    connection.emit('stateChange', old, connection.state);
    return connection;
  });
  return { bot, router, states, state, members, guild, connection, subscribe, subscriptions, configureClient,
    setRole(userId: string, enabled: boolean) {
      const member = members.get(userId)!;
      if (enabled) member.roles.cache.set(config.leaderRoleId, {});
      else member.roles.cache.delete(config.leaderRoleId);
      bot.client.emit(Events.GuildMemberUpdate, {} as never, member as never);
    },
    change(userId: string | null) {
      for (const member of members.values()) {
        member.roles.cache.clear();
        if (member.id === userId) member.roles.cache.set(config.leaderRoleId, {});
      }
      bot.refresh();
    },
  };
}

describe('Discord lifecycle', () => {
  it('logs in without destroying the client first', async () => {
    const { bot } = setup();
    expect(bot.status().gateway).toBe(false);
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.client.login).toHaveBeenCalledOnce();
    expect(bot.client.destroy).not.toHaveBeenCalled();
    expect(bot.status().receiving).toBe(true);
  });
  it('waits for client readiness after login resolves before joining voice', async () => {
    const { bot } = setup();
    vi.spyOn(bot.client, 'login').mockResolvedValueOnce('token');
    bot.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.join).not.toHaveBeenCalled();
    expect(bot.client.login).toHaveBeenCalledOnce();
    expect(bot.status().lastError).toBeNull();
    Object.assign(bot.client, { ready: true });
    bot.client.emit(Events.ClientReady, bot.client as Client<true>);
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.status().receiving).toBe(true);
    expect(bot.client.listenerCount(Events.ClientReady)).toBe(1);
  });
  it('replaces a failed client and preserves interaction handling after retry', async () => {
    const onInteraction = vi.fn();
    const { bot, configureClient } = setup(onInteraction);
    const previous = bot.client;
    vi.spyOn(previous, 'login').mockImplementationOnce(async () => {
      await previous.destroy(); // discord.js also destroys the client when login fails.
      throw new Error('temporary gateway failure');
    });
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.client).not.toBe(previous);
    expect(bot.status().receiving).toBe(false);
    configureClient();
    await vi.advanceTimersByTimeAsync(1001);
    expect(bot.status().receiving).toBe(true);
    expect(bot.client.login).toHaveBeenCalledOnce();
    expect(bot.status().lastError).toBeNull();
    const interaction = { id: 'interaction' } as Interaction;
    previous.emit(Events.InteractionCreate, interaction);
    bot.client.emit(Events.InteractionCreate, interaction);
    expect(onInteraction).toHaveBeenCalledExactlyOnceWith(interaction);
    previous.emit(Events.ShardReconnecting, 0);
    expect(bot.status().receiving).toBe(true);
  });
  it('waits for gateway resume without destroying the client or logging in again', async () => {
    const { bot, connection, configureClient } = setup();
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    const client = bot.client;
    client.emit(Events.ShardReconnecting, 0);
    expect(bot.status().gateway).toBe(false);
    expect(bot.status().receiving).toBe(false);
    bot.refresh();
    expect(bot.status().receiving).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.login).toHaveBeenCalledOnce();
    expect(client.destroy).not.toHaveBeenCalled();
    expect(bot.status().lastError).toBeNull();
    // The voice connection was torn down while waiting for the gateway.
    connection.state = { status: 'ready' };
    configureClient();
    client.emit(Events.ShardResume, 0, 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.client).toBe(client);
    expect(bot.status().receiving).toBe(true);
  });
  it('replaces a client that never becomes ready and retries with backoff', async () => {
    const { bot, configureClient } = setup();
    const previous = bot.client;
    vi.spyOn(previous, 'login').mockResolvedValueOnce('token');
    bot.start();
    await vi.advanceTimersByTimeAsync(30001);
    expect(previous.destroy).toHaveBeenCalled();
    expect(previous.listenerCount(Events.ClientReady)).toBe(1);
    expect(bot.client).not.toBe(previous);
    expect(bot.client.login).not.toHaveBeenCalled();
    configureClient();
    await vi.advanceTimersByTimeAsync(1001);
    expect(bot.status().receiving).toBe(true);
  });
  it('cancels gateway readiness waits on shutdown without scheduling a retry', async () => {
    const { bot } = setup();
    vi.spyOn(bot.client, 'login').mockResolvedValueOnce('token');
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    const client = bot.client;
    await bot.stop();
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.client).toBe(client);
    expect(bot.status().lastError).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(client.listenerCount(Events.ClientReady)).toBe(1);
    expect(mocks.join).not.toHaveBeenCalled();
  });
  it('joins with a separate connection group and captures only human voice members with the leader role', async () => {
    const { bot, subscribe } = setup();
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.join).toHaveBeenCalledWith(expect.objectContaining({ group: 'bot1', selfDeaf: false, selfMute: false, channelId: channels[1] }));
    expect(subscribe).toHaveBeenCalledOnce();
    expect(subscribe.mock.calls[0]![0]).toBe('alice');
    expect(bot.status().receiving).toBe(true);
  });
  it('subscribes to all human leaders and revokes just the member losing the role', async () => {
    const { bot, setRole, subscribe, subscriptions, guild } = setup();
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.client.options).toMatchObject({ intents: expect.arrayContaining([GatewayIntentBits.GuildMembers]) });
    expect(bot.status()).toMatchObject({ leadersKnown: true, leaderIds: ['alice'] });
    setRole('bob', true);
    expect(bot.status().leaderIds).toEqual(['alice', 'bob']);
    expect([...subscriptions.keys()].sort()).toEqual(['alice', 'bob']);
    const alice = subscriptions.get('alice')!;
    const bob = subscriptions.get('bob')!;
    guild.roles.fetch.mockClear();
    setRole('alice', false);
    expect(alice.destroyed).toBe(true);
    expect(bob.destroyed).toBe(false);
    expect(bot.status().leaderIds).toEqual(['bob']);
    expect(bot.status().receiving).toBe(true);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(guild.roles.fetch).not.toHaveBeenCalled();
    // Bots bearing the leader role were never captured.
    expect(subscriptions.has('relay-bot')).toBe(false);
    alice.emit('data', Buffer.alloc(4));
    expect(bot.status().receiving).toBe(true);
  });
  it('isolates decoder or stream failures to one speaker and retries it', async () => {
    const { bot, setRole, subscriptions } = setup();
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    setRole('bob', true);
    const alice = subscriptions.get('alice')!;
    const bob = subscriptions.get('bob')!;
    alice.emit('error', new Error('receive failure'));
    expect(alice.destroyed).toBe(true);
    expect(bob.destroyed).toBe(false);
    expect(bot.status().receiving).toBe(true);
    await vi.advanceTimersByTimeAsync(1001);
    expect(subscriptions.get('alice')).not.toBe(alice);
    expect(subscriptions.get('bob')).toBe(bob);
  });
  it('stops a leader moving out of the assigned channel while others continue', async () => {
    const { bot, setRole, states, state, subscriptions, members } = setup();
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    setRole('bob', true);
    const alice = subscriptions.get('alice')!;
    const bob = subscriptions.get('bob')!;
    const next = state('alice', channels[2]);
    states.set('alice', next);
    members.get('alice')!.voice.channelId = next.channelId;
    bot.client.emit(Events.VoiceStateUpdate, state('alice') as never, { ...next, guild: { id: config.guildId } } as never);
    expect(alice.destroyed).toBe(true);
    expect(bob.destroyed).toBe(false);
    expect(bot.status().leaderIds).toEqual(['bob']);
  });
  it('does not relay until role and membership verification completes', async () => {
    const { bot, guild, subscribe } = setup();
    let release!: () => void;
    guild.members.fetch.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(guild.members.cache.get('alice')); }));
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    bot.refresh();
    expect(bot.status()).toMatchObject({ leadersKnown: false, leaderIds: [], receiving: false });
    expect(subscribe).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.status().receiving).toBe(true);
  });
  it('retries verification if a role changes while the initial fetch is pending', async () => {
    const { bot, guild, setRole, subscribe } = setup();
    let release!: () => void;
    guild.members.fetch.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(guild.members.cache.get('alice')); }));
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    setRole('alice', false);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(subscribe).not.toHaveBeenCalled();
    expect(bot.status()).toMatchObject({ leadersKnown: true, leaderIds: [], receiving: false });
  });
  it('fails closed when verifying a voice member fails', async () => {
    const { bot, guild, subscribe } = setup();
    guild.members.fetch.mockRejectedValueOnce(new Error('temporary API failure'));
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.status()).toMatchObject({ leadersKnown: false, leaderIds: [], receiving: false });
    expect(subscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1001);
    expect(bot.status()).toMatchObject({ leadersKnown: true, leaderIds: ['alice'], receiving: true });
  });
  it('discards a stale member when Discord reports they have left the server', async () => {
    const { bot, guild, subscribe } = setup();
    guild.members.fetch.mockRejectedValueOnce(Object.assign(new Error('Unknown Member'), { code: 10007 }));
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(subscribe).not.toHaveBeenCalled();
    expect(bot.status()).toMatchObject({ leadersKnown: true, leaderIds: [], receiving: false });
  });
  it('keeps leader eligibility when the role is renamed', async () => {
    const { bot, subscriptions } = setup();
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    const alice = subscriptions.get('alice');
    bot.client.emit(Events.GuildRoleUpdate, { id: config.leaderRoleId, name: 'Leader' } as never,
      { id: config.leaderRoleId, name: 'Captain' } as never);
    bot.refresh();
    expect(subscriptions.get('alice')).toBe(alice);
    expect(bot.status().leaderIds).toEqual(['alice']);
  });
  it('revalidates roles after gateway resume and never restarts a revoked speaker', async () => {
    const { bot, guild, members, connection } = setup();
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    bot.client.emit(Events.ShardReconnecting, 0);
    expect(bot.status()).toMatchObject({ leadersKnown: false, leaderIds: [], receiving: false });
    await vi.advanceTimersByTimeAsync(1);
    // Simulate a role revoked while disconnected: REST refresh corrects the old cache.
    guild.members.fetch.mockImplementation(async ({ user }) => {
      const member = members.get(user)!;
      if (user === 'alice') member.roles.cache.clear();
      return member;
    });
    connection.state = { status: 'ready' };
    bot.client.emit(Events.ShardResume, 0, 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.status()).toMatchObject({ leadersKnown: true, leaderIds: [], receiving: false });
  });
  it('stops capture when the configured role is deleted and reports an invalid role', async () => {
    const { bot, guild, subscriptions } = setup();
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    const alice = subscriptions.get('alice')!;
    guild.roles.fetch.mockResolvedValue(null as never);
    bot.client.emit(Events.GuildRoleDelete, { id: config.leaderRoleId, guild: { id: config.guildId } } as never);
    expect(alice.destroyed).toBe(true);
    expect(bot.status().receiving).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.status()).toMatchObject({ leadersKnown: false, lastError: 'INVALID_LEADER_ROLE' });
  });
  it('rejects @everyone as the leader role', async () => {
    const { bot, guild } = setup();
    guild.roles.fetch.mockResolvedValue({ id: config.guildId });
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.status().lastError).toBe('INVALID_LEADER_ROLE');
    expect(mocks.join).not.toHaveBeenCalled();
  });
  it('replaces an ongoing capture synchronously and closes its decoder', async () => {
    const { bot, subscriptions, subscribe, change } = setup();
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    const old = subscriptions.get('alice')!;
    old.write(Buffer.alloc(FRAME_BYTES));
    change('bob');
    expect(old.destroyed).toBe(true);
    expect(mocks.codecClosed).toHaveBeenCalledOnce();
    expect(subscribe.mock.calls.at(-1)![0]).toBe('bob');
    expect(bot.status().receiving).toBe(true);
    change(null);
    expect(bot.status().receiving).toBe(false);
  });
  it('automatically resumes capture after the leader leaves and rejoins', async () => {
    const { bot, states, state, subscribe } = setup();
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    states.delete('alice');
    bot.client.emit(Events.VoiceStateUpdate, state('alice') as never, { id: 'alice', channelId: null, guild: { id: config.guildId } } as never);
    expect(bot.status().receiving).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    states.set('alice', state('alice'));
    bot.client.emit(Events.VoiceStateUpdate, { id: 'alice', channelId: null } as never, { ...state('alice'), guild: { id: config.guildId } } as never);
    expect(bot.status().receiving).toBe(true);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });
  it('disables capture on disconnect and restores it after connection recovery', async () => {
    const { bot, connection } = setup();
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    const old = connection.state;
    connection.state = { status: 'disconnected' };
    connection.emit('stateChange', old, connection.state);
    expect(bot.status().receiving).toBe(false);
    await vi.advanceTimersByTimeAsync(1001);
    expect(bot.status().receiving).toBe(true);
    expect(mocks.enter).toHaveBeenCalled();
  });
  it('retries voice connection failures and clears its timers on shutdown', async () => {
    const { bot, connection } = setup();
    mocks.join.mockImplementationOnce(() => { throw new Error('temporary voice error'); });
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.status().receiving).toBe(false);
    await vi.advanceTimersByTimeAsync(1001);
    expect(bot.status().receiving).toBe(true);
    await bot.stop();
    expect(connection.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not create a new voice connection if shutdown occurs during an async fetch', async () => {
    const { bot, guild } = setup();
    let release!: (value: never) => void;
    vi.mocked(bot.client.guilds.fetch).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    await bot.stop();
    release(guild as never);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.join).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});


describe('dynamic worker assignments', () => {
  const options = (active = true): WorkerOptions => ({ workerId: 1, token: 'a', channelId: channels[1], active, onIdentity: vi.fn(async () => {}) });
  it('serves commands while paused without joining voice', async () => {
    const interaction = vi.fn();
    const settings = options(false);
    const { bot } = setup(interaction, settings);
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(settings.onIdentity).toHaveBeenCalledExactlyOnceWith('bot1');
    expect(registerCommands).toHaveBeenCalled();
    expect(mocks.join).not.toHaveBeenCalled();
    expect(bot.status()).toMatchObject({ leadersKnown: true, leaderIds: ['alice'], receiving: false });
    bot.client.emit(Events.InteractionCreate, { commandName: 'group' } as Interaction);
    expect(interaction).toHaveBeenCalledOnce();
  });
  it('never joins voice before verifying the persisted bot identity', async () => {
    const settings = options();
    vi.mocked(settings.onIdentity).mockRejectedValueOnce(Object.assign(new Error('duplicate account'), { code: 'BOT_IDENTITY_CONFLICT' }));
    const { bot } = setup(undefined, settings);
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.join).not.toHaveBeenCalled();
    expect(bot.status().lastError).toBe('BOT_IDENTITY_CONFLICT');
    await vi.advanceTimersByTimeAsync(1001);
    expect(bot.status().receiving).toBe(true);
  });
  it('cancels pending voice work when the group is paused', async () => {
    const { bot, guild, router } = setup(undefined, options());
    let finish!: (value: never) => void;
    vi.mocked(bot.client.guilds.fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    bot.configure(1, router, channels[1], false);
    finish(guild as never);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.join).not.toHaveBeenCalled();
    expect(bot.status().receiving).toBe(false);
    expect(bot.status().gateway).toBe(true);
  });
  it('ignores errors emitted by a replaced connection', async () => {
    const { bot, connection, router } = setup(undefined, options());
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    bot.configure(1, router, channels[1], false);
    connection.emit('error', new Error('late error'));
    expect(bot.status().lastError).toBeNull();
    expect(bot.status().gateway).toBe(true);
  });
});
