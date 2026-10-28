import pino, { type DestinationStream, type LoggerOptions } from 'pino';
import type { Config } from './config.js';

// Scrub secrets even when a dependency embeds them in an exception string or URL.
export function createLogger(config: Config, destination?: DestinationStream) {
  const secrets = config.workers.map(worker => worker.token);
  const options: LoggerOptions = {
    level: config.logLevel,
    serializers: {
      // AudioPlayerError includes a resource/stream: never serialize arbitrary error properties.
      err(error: unknown) {
        return error instanceof Error ? { type: error.name, message: error.message, stack: error.stack, code: safeError(error) }
          : { type: 'Error', code: safeError(error) };
      },
    },
    redact: { paths: ['token', 'password', 'authorization'], censor: '[REDACTED]' },
    hooks: {
      streamWrite(text) {
        for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
        return text;
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

// Status replies deliberately avoid raw dependency messages, which can contain secrets.
export function safeError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'CONNECTION_OR_AUDIO_ERROR';
}
