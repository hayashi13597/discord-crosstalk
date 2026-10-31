import { afterEach, expect, it, vi } from 'vitest';
import { RateLimitError, REST, type RESTOptions, type ResponseLike } from 'discord.js';
import type { Logger } from 'pino';
import { gatewayRestOptions } from '../src/gateway-rest.js';

const transports: REST[] = [];
function response(body: string, init?: ResponseInit): ResponseLike {
  const result = new Response(body, init);
  return { status: result.status, statusText: result.statusText, ok: result.ok, headers: result.headers,
    body: null, get bodyUsed() { return result.bodyUsed; },
    arrayBuffer: () => result.arrayBuffer(), json: () => result.json(), text: () => result.text() };
}
afterEach(() => {
  for (const rest of transports.splice(0)) { rest.clearHashSweeper(); rest.clearHandlerSweeper(); }
  vi.useRealTimers();
});

function setup(request: RESTOptions['makeRequest'], active = () => true) {
  const log = { info: vi.fn(), warn: vi.fn() };
  const rest = new REST({ ...gatewayRestOptions(log as unknown as Logger, 2, active, request) })
    .setToken('private-bot-token');
  transports.push(rest);
  return { rest, log };
}

it('uses the actual gateway request and records selected HTTP fields without request data or body', async () => {
  const request = vi.fn<RESTOptions['makeRequest']>().mockResolvedValue(response(JSON.stringify({ url: 'wss://gateway.discord.gg' }), {
    headers: { 'content-type': 'application/json', 'set-cookie': 'private-cookie' },
  }));
  const { rest, log } = setup(request);
  expect(await rest.get('/gateway/bot')).toEqual({ url: 'wss://gateway.discord.gg' });
  expect(request).toHaveBeenCalledOnce();
  expect(log.info).toHaveBeenLastCalledWith({ worker: 2, status: 200, contentType: 'application/json',
    retryAfter: null, server: null, cfRay: null }, 'Discord gateway HTTP response');
  expect(JSON.stringify(log.info.mock.calls)).not.toMatch(/private-bot-token|private-cookie|wss:/);
});

it('surfaces HTML 429 responses before JSON parsing or a hidden retry', async () => {
  const request = vi.fn<RESTOptions['makeRequest']>().mockResolvedValue(response('<html>private-body</html>', {
    status: 429, headers: { 'content-type': 'text/html', 'retry-after': '120', server: 'cloudflare', 'cf-ray': 'test-ray' },
  }));
  const { rest, log } = setup(request);
  const error = await rest.get('/gateway/bot').catch(error => error);
  expect(error).toBeInstanceOf(RateLimitError);
  if (!(error instanceof RateLimitError)) throw error;
  expect(error.retryAfter).toBeGreaterThanOrEqual(120000);
  expect(request).toHaveBeenCalledOnce();
  expect(log.warn).toHaveBeenCalledWith({ worker: 2, status: 429, contentType: 'text/html',
    retryAfter: '120', server: 'cloudflare', cfRay: 'test-ray' }, 'Discord gateway HTTP response');
  expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private-body');
});

it('surfaces a network timeout after one 15s attempt instead of retrying beyond the supervisor deadline', async () => {
  vi.useFakeTimers();
  const request = vi.fn<RESTOptions['makeRequest']>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('Request timed out', 'AbortError')), { once: true });
  }));
  const { rest, log } = setup(request);
  const rejected = expect(rest.get('/gateway/bot')).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(15001);
  await rejected;
  await vi.advanceTimersByTimeAsync(30000);
  expect(request).toHaveBeenCalledOnce();
  expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ worker: 2, err: expect.objectContaining({ name: 'AbortError' }) }),
    'Discord gateway HTTP request failed');
});

it('surfaces a 503 without another HTTP attempt', async () => {
  const request = vi.fn<RESTOptions['makeRequest']>().mockResolvedValue(response('Unavailable', { status: 503 }));
  const { rest } = setup(request);
  await expect(rest.get('/gateway/bot')).rejects.toMatchObject({ status: 503 });
  expect(request).toHaveBeenCalledOnce();
});

it('records the underlying DNS error code when fetch wraps it in a TypeError', async () => {
  const error = new TypeError('fetch failed', { cause: Object.assign(new Error('DNS failed'), { code: 'EAI_AGAIN' }) });
  const request = vi.fn<RESTOptions['makeRequest']>().mockRejectedValue(error);
  const { rest, log } = setup(request);
  await expect(rest.get('/gateway/bot')).rejects.toBe(error);
  expect(log.warn).toHaveBeenCalledWith({ worker: 2, err: error, networkCode: 'EAI_AGAIN' }, 'Discord gateway HTTP request failed');
});

it('does not publish stale client results or inspect unrelated route bodies', async () => {
  const request = vi.fn<RESTOptions['makeRequest']>().mockImplementation(async () => response('{}', { headers: { 'content-type': 'application/json' } }));
  const { rest, log } = setup(request, () => false);
  await rest.get('/gateway/bot');
  await rest.get('/users/@me');
  expect(request).toHaveBeenCalledTimes(2);
  expect(log.info).not.toHaveBeenCalled();
  expect(log.warn).not.toHaveBeenCalled();
});
