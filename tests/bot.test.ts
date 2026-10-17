import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioRouter, FRAME_BYTES } from '../src/audio/router.js';
import { loadConfig } from '../src/config.js';
import { TeamBot, type WorkerOptions } from '../src/bot.js';
import { registerCommands } from '../src/commands.js';
import { Events, type Client, type Interaction } from 'discord.js';
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
  GUILD_ID: '123456789012345678', BOT_TOKEN_1: 'a', BOT_TOKEN_2: 'b', BOT_TOKEN_3: 'c',
  VOICE_CHANNEL_ID_1: '123456789012345671', VOICE_CHANNEL_ID_2: '123456789012345672', VOICE_CHANNEL_ID_3: '123456789012345673',
  DATABASE_URL: 'postgresql://localhost/test',
});
const activeBots: TeamBot[] = [];
afterEach(async () => {
  await Promise.all(activeBots.splice(0).map(bot => bot.stop()));
  vi.useRealTimers();
  vi.clearAllMocks();
});

function setup(onInteraction?: ConstructorParameters<typeof TeamBot>[5], options?: WorkerOptions) {
  vi.useFakeTimers();
  const router = new AudioRouter({ 1: config.bots[1].channelId, 2: config.bots[2].channelId, 3: config.bots[3].channelId }, config);
  let leaders = { 1: 'alice' as string | null, 2: null, 3: null };
  router.setLeaders(leaders);
  const bot = new TeamBot(1, config, router, () => leaders, { info: vi.fn(), warn: vi.fn() } as unknown as Logger, onInteraction, options);
  activeBots.push(bot);
  const voice = { channelId: config.bots[1].channelId, serverDeaf: false, serverMute: false };
  const states = new Map([['alice', { channelId: config.bots[1].channelId }], ['bob', { channelId: config.bots[1].channelId }]]);
  const me = { voice };
  const guild = { id: config.guildId, members: { me, fetchMe: vi.fn(async () => me) },
    channels: { fetch: vi.fn(async () => ({ id: config.bots[1].channelId, type: 2, permissionsFor: () => ({ has: () => true }) })) },
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
    state: { status: 'ready' }, joinConfig: { channelId: config.bots[1].channelId }, receiver: { subscriptions, subscribe },
    subscribe: vi.fn(), destroy: vi.fn(() => { connection.state.status = 'destroyed'; }),
  });
  mocks.join.mockReturnValue(connection);
  mocks.enter.mockImplementation(async () => {
    const old = connection.state;
    connection.state = { status: 'ready' };
    connection.emit('stateChange', old, connection.state);
    return connection;
  });
  return { bot, router, states, guild, connection, subscribe, subscriptions, configureClient,
    change(userId: string | null) { leaders = { ...leaders, 1: userId }; router.setLeaders(leaders); bot.refresh(); },
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
  it('joins with a separate connection group and captures only the assigned leader', async () => {
    const { bot, subscribe } = setup();
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.join).toHaveBeenCalledWith(expect.objectContaining({ group: 'bot1', selfDeaf: false, selfMute: false, channelId: config.bots[1].channelId }));
    expect(subscribe).toHaveBeenCalledOnce();
    expect(subscribe.mock.calls[0]![0]).toBe('alice');
    expect(bot.status().receiving).toBe(true);
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
    const { bot, states, subscribe } = setup();
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    states.delete('alice');
    bot.client.emit(Events.VoiceStateUpdate, { id: 'alice' } as never, { id: 'alice', guild: { id: config.guildId } } as never);
    expect(bot.status().receiving).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    states.set('alice', { channelId: config.bots[1].channelId });
    bot.client.emit(Events.VoiceStateUpdate, { id: 'alice' } as never, { id: 'alice', guild: { id: config.guildId } } as never);
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
  const options = (active = true): WorkerOptions => ({ workerId: 1, token: 'a', channelId: config.bots[1].channelId, active, onIdentity: vi.fn(async () => {}) });
  it('serves commands while paused without joining voice', async () => {
    const interaction = vi.fn();
    const settings = options(false);
    const { bot } = setup(interaction, settings);
    bot.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(settings.onIdentity).toHaveBeenCalledExactlyOnceWith('bot1');
    expect(registerCommands).toHaveBeenCalled();
    expect(mocks.join).not.toHaveBeenCalled();
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
    bot.configure(1, router, () => ({ 1: 'alice', 2: null, 3: null }), config.bots[1].channelId, false);
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
    bot.configure(1, router, () => ({ 1: 'alice', 2: null, 3: null }), config.bots[1].channelId, false);
    connection.emit('error', new Error('late error'));
    expect(bot.status().lastError).toBeNull();
    expect(bot.status().gateway).toBe(true);
  });
});
