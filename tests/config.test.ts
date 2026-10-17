import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { retryDelay } from '../src/bot.js';
import { safeError } from '../src/logger.js';

export const validEnv = {
  GUILD_ID: '123456789012345678', BOT_TOKEN_1: 'secret-token-a', BOT_TOKEN_2: 'secret-token-b', BOT_TOKEN_3: 'secret-token-c',
  VOICE_CHANNEL_ID_1: '123456789012345671', VOICE_CHANNEL_ID_2: '123456789012345672', VOICE_CHANNEL_ID_3: '123456789012345673',
  DATABASE_URL: 'postgresql://user:password@localhost/test',
};
describe('configuration', () => {
  it('uses low latency defaults', () => {
    expect(loadConfig(validEnv)).toMatchObject({ jitterMs: 60, maxQueueMs: 200, singleGain: 1, mixGain: 0.5, adminRoleIds: [] });
  });
  it.each([
    { BOT_TOKEN_1: '' }, { BOT_TOKEN_1: validEnv.BOT_TOKEN_2 }, { VOICE_CHANNEL_ID_1: validEnv.VOICE_CHANNEL_ID_2 },
    { GUILD_ID: 'invalid' }, { DATABASE_URL: 'sqlite:test' }, { JITTER_BUFFER_MS: '45' }, { MAX_QUEUE_MS: '60' },
    { MIX_SOURCE_GAIN: 'NaN' }, { ADMIN_ROLE_IDS: 'invalid' },
  ])('rejects invalid config %j', override => {
    expect(() => loadConfig({ ...validEnv, ...override })).toThrow();
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
