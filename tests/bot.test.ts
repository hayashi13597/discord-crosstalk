import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioRouter, FRAME_BYTES } from '../src/audio/router.js';
import { loadConfig } from '../src/config.js';
import { TeamBot } from '../src/bot.js';
import { Events } from 'discord.js';
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
    ready = true;
    user = { id: 'bot1' };
    application = { id: 'bot1' };
    users = { cache: new Map([['alice', { id: 'alice', bot: false }], ['bob', { id: 'bob', bot: false }]]) };
    guilds = { cache: new Map(), fetch: vi.fn() };
    isReady() { return this.ready; }
    async login() { this.ready = true; return 'token'; }
    async destroy() { this.ready = false; }
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

function setup() {
  vi.useFakeTimers();
  const router = new AudioRouter({ 1: config.bots[1].channelId, 2: config.bots[2].channelId, 3: config.bots[3].channelId }, config);
  let leaders = { 1: 'alice' as string | null, 2: null, 3: null };
  router.setLeaders(leaders);
  const bot = new TeamBot(1, config, router, () => leaders, { info: vi.fn(), warn: vi.fn() } as unknown as Logger);
  activeBots.push(bot);
  const voice = { channelId: config.bots[1].channelId, serverDeaf: false, serverMute: false };
  const states = new Map([['alice', { channelId: config.bots[1].channelId }], ['bob', { channelId: config.bots[1].channelId }]]);
  const me = { voice };
  const guild = { id: config.guildId, members: { me, fetchMe: vi.fn(async () => me) },
    channels: { fetch: vi.fn(async () => ({ id: config.bots[1].channelId, type: 2, permissionsFor: () => ({ has: () => true }) })) },
    voiceStates: { cache: states }, voiceAdapterCreator: vi.fn(),
  };
  bot.client.guilds.cache.set(config.guildId, guild as never);
  vi.mocked(bot.client.guilds.fetch).mockResolvedValue(guild as never);
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
  return { bot, router, states, guild, connection, subscribe, subscriptions,
    change(userId: string | null) { leaders = { ...leaders, 1: userId }; router.setLeaders(leaders); bot.refresh(); },
  };
}

describe('Discord lifecycle', () => {
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
