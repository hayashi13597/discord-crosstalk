import { describe, it, expect } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { retryDelay } from '../src/bot.js';
import { safeError } from '../src/logger.js';

export const validEnv = {
  GUILD_ID: '123456789012345678', LEADER_ROLE_ID: '123456789012345680', BOT_TOKEN_1: 'secret-token-a', BOT_TOKEN_2: 'secret-token-b', BOT_TOKEN_3: 'secret-token-c',
};
describe('configuration', () => {
  it('uses low latency defaults', () => {
    expect(loadConfig(validEnv)).toMatchObject({ jitterMs: 60, maxQueueMs: 200, singleGain: 1, mixGain: 0.5, adminRoleIds: [], leaderRoleId: validEnv.LEADER_ROLE_ID });
  });
  it.each([
    { BOT_TOKEN_1: '' }, { BOT_TOKEN_1: validEnv.BOT_TOKEN_2 }, { DATABASE_PATH: '' },
    { GUILD_ID: 'invalid' }, { DATABASE_PATH: ':memory:' }, { JITTER_BUFFER_MS: '45' }, { MAX_QUEUE_MS: '60' },
    { LEADER_ROLE_ID: undefined }, { LEADER_ROLE_ID: '' }, { LEADER_ROLE_ID: 'invalid' }, { MIX_SOURCE_GAIN: 'NaN' }, { ADMIN_ROLE_IDS: 'invalid' },
  ])('rejects invalid config %j with safe ConfigError message', override => {
    let caught: unknown;
    try { loadConfig({ ...validEnv, ...override }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).not.toContain('secret-token');
  });
  it('starts without database service or channel environment variables', () => {
    const config = loadConfig({ GUILD_ID: validEnv.GUILD_ID, LEADER_ROLE_ID: validEnv.LEADER_ROLE_ID, BOT_TOKEN_1: 'a', BOT_TOKEN_2: 'b', BOT_TOKEN_3: 'c' });
    expect(config.databasePath).toBe('./data/crosstalk.sqlite');
    expect(config.workers.map(worker => worker.id)).toEqual([1, 2, 3]);
  });
  it('caps recovery backoff at 30s with jitter', () => {
    expect(retryDelay(0, () => 0)).toBe(800);
    expect(retryDelay(20, () => 1)).toBe(30000);
  });
  it('keeps raw dependency errors out of Discord replies', () => {
    expect(safeError(new Error('token secret-token-a'))).toBe('CONNECTION_OR_AUDIO_ERROR');
    expect(safeError({ code: 'ECONNRESET' })).toBe('ECONNRESET');
  });
});


describe('worker pool configuration', () => {
  it('supports extra workers without voice-channel environment variables', () => {
    const result = loadConfig({ ...validEnv, BOT_TOKEN_6: 'new-f', BOT_TOKEN_4: 'new-d', BOT_TOKEN_5: 'new-e' });
    expect(result.workers.map(worker => worker.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('rejects duplicate tokens across the entire pool', () => {
    expect(() => loadConfig({ ...validEnv, BOT_TOKEN_4: validEnv.BOT_TOKEN_1 })).toThrow('distinct');
  });
});
