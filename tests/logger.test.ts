import { expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';
import { loadConfig } from '../src/config.js';

it('scrubs secrets in exception text and excludes audio resources from logs', () => {
  const config = loadConfig({
    GUILD_ID: '123456789012345678', BOT_TOKEN_1: 'secret-token-1', BOT_TOKEN_2: 'secret-token-2', BOT_TOKEN_3: 'secret-token-3',
    VOICE_CHANNEL_ID_1: '123456789012345671', VOICE_CHANNEL_ID_2: '123456789012345672', VOICE_CHANNEL_ID_3: '123456789012345673',
    DATABASE_URL: 'postgresql://user:private-password@localhost/test',
  });
  const chunks: string[] = [];
  const log = createLogger(config, { write(chunk: string) { chunks.push(chunk); } });
  const error = Object.assign(new Error(`Failed ${config.bots[1].token} ${config.databaseUrl} private-password`), {
    resource: { packet: Buffer.from('private-voice-data') }, requestBody: { token: config.bots[2].token },
  });
  log.error({ err: error }, 'Playback failed');
  const output = chunks.join('');
  expect(output).toContain('Playback failed');
  expect(output).not.toContain('private-password');
  expect(output).not.toContain('secret-token');
  expect(output).not.toContain('resource');
  expect(output).not.toContain('private-voice-data');
  expect(output).not.toContain('packet');
  expect(() => JSON.parse(output)).not.toThrow();
});
