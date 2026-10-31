import { DefaultRestOptions, type RESTOptions } from 'discord.js';
import type { Logger } from 'pino';
import { safeError } from './logger.js';

export function gatewayRestOptions(log: Logger, worker: number, active: () => boolean,
  request: RESTOptions['makeRequest'] = DefaultRestOptions.makeRequest): Partial<RESTOptions> {
  return {
    timeout: 15000,
    // Worker supervision retries failed reads. Hidden REST retries can otherwise
    // outlive the 30s gateway deadline and continue after Client.destroy().
    retries: 0,
    // Let the supervisor retain the cooldown across replacement clients.
    // Other routes keep discord.js's normal rate-limit queue.
    rejectOnRateLimit: data => data.route === '/gateway/bot',
    async makeRequest(url, init) {
      if (new URL(url).pathname !== '/api/v10/gateway/bot') return request(url, init);
      if (active()) log.info({ worker }, 'Requesting Discord gateway information over HTTPS');
      try {
        const response = await request(url, init);
        if (active()) {
          const fields = { worker, status: response.status,
            contentType: response.headers.get('content-type'), retryAfter: response.headers.get('retry-after'),
            server: response.headers.get('server'), cfRay: response.headers.get('cf-ray') };
          // Never log headers containing credentials, request data or response bodies.
          if (response.ok) log.info(fields, 'Discord gateway HTTP response');
          else log.warn(fields, 'Discord gateway HTTP response');
        }
        return response;
      } catch (error) {
        const cause = error instanceof Error && error.cause ? error.cause : error;
        if (active()) log.warn({ worker, err: error, networkCode: safeError(cause) }, 'Discord gateway HTTP request failed');
        throw error;
      }
    },
  };
}
