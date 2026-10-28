import { expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';
import { loadConfig } from '../src/config.js';

it('scrubs secrets in exception text and excludes audio resources from logs', () => {
  const config = loadConfig({
    BOT_TOKEN_4: 'secret-extra-worker', GUILD_ID: '123456789012345678', LEADER_ROLE_ID: '123456789012345680', BOT_TOKEN_1: 'secret-token-1', BOT_TOKEN_2: 'secret-token-2', BOT_TOKEN_3: 'secret-token-3',
  });
  const chunks: string[] = [];
  const log = createLogger(config, { write(chunk: string) { chunks.push(chunk); } });
  const error = Object.assign(new Error(`Failed ${config.workers[0]!.token} secret-extra-worker`), {
    resource: { packet: Buffer.from('private-voice-data') }, requestBody: { token: config.workers[1]!.token },
  });
  log.error({ err: error }, 'Playback failed');
  const output = chunks.join('');
  expect(output).toContain('Playback failed');
  expect(output).not.toContain('secret-token');
  expect(output).not.toContain('secret-extra-worker');
  expect(output).not.toContain('resource');
  expect(output).not.toContain('private-voice-data');
  expect(output).not.toContain('packet');
  expect(() => JSON.parse(output)).not.toThrow();
});
