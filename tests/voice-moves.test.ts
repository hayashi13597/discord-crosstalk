import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceMoveService, MoveRetry, type MoveGateway, type MoveScan } from '../src/voice-moves.js';
import { MemoryMoves, moveInput } from './voice-move-helpers.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const empty = (): MoveScan => ({ checkedAt: Date.now(), remaining: [], unverified: [], resolved: [] });
async function settle<T>(task: Promise<T>): Promise<T> {
  const handled = task.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const result = await handled;
  if ('error' in result) throw result.error;
  return result.value;
}
function setup(count = 3) {
  const repository = new MemoryMoves();
  const errors = vi.fn();
  const service = new VoiceMoveService(repository, errors);
  const input = moveInput(count);
  const gateway: MoveGateway = { ready: vi.fn(() => true), validate: vi.fn(async () => {}), scan: vi.fn(async () => empty()),
    move: vi.fn(async member => {
      expect(repository.jobs.get(input.id)!.members.find(value => value.userId === member.userId)!.status).toBe('processing');
      return { status: 'moved' as const, reason: null };
    }) };
  const notify = vi.fn(async () => {});
  return { repository, errors, service, input, gateway, notify, run: () => settle(service.run(input, gateway, notify)) };
}
describe('durable mass voice move worker', () => {
  it('persists before moving, skips redundant round-0 enqueue, and requires two empty scans before completion', async () => {
    const state = setup();
    await state.run();
    expect(state.repository.enqueue).not.toHaveBeenCalled();
    expect(state.gateway.scan).toHaveBeenCalledTimes(2);
    expect(state.repository.jobs.get(state.input.id)).toMatchObject({ status: 'Completed', verification: { remaining: [], unverified: [] } });
    expect(state.notify).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'Completed' }));
  });
  it('continues past a member failure, discovers new arrivals, and persists them before moving', async () => {
    const state = setup(2);
    vi.mocked(state.gateway.move).mockResolvedValueOnce({ status: 'failed', reason: 'discord_400' });
    vi.mocked(state.gateway.scan).mockResolvedValueOnce({ ...empty(), remaining: [{ userId: 'late', sourceId: 'a' }] });
    await state.run();
    expect(vi.mocked(state.gateway.move).mock.calls.map(([member]) => member.userId)).toEqual(['user0', 'user1', 'late']);
    expect(state.repository.jobs.get(state.input.id)!.members).toHaveLength(3);
    expect(state.repository.jobs.get(state.input.id)!.status).toBe('Partially Completed');
  });
  it('retries temporary failures at most three times and still processes other members', async () => {
    const state = setup(2);
    vi.mocked(state.gateway.move).mockResolvedValueOnce({ status: 'unknown', reason: 'outcome_unknown' })
      .mockResolvedValueOnce({ status: 'failed', reason: 'discord_unavailable' })
      .mockResolvedValueOnce({ status: 'unknown', reason: 'outcome_unknown' });
    vi.mocked(state.gateway.scan).mockResolvedValue({ ...empty(), remaining: [state.input.members[0]!] });
    await state.run();
    expect(state.gateway.move).toHaveBeenCalledTimes(4);
    expect(state.repository.jobs.get(state.input.id)).toMatchObject({ status: 'Interrupted', reason: 'members_remaining', verification: { remaining: [state.input.members[0]!] } });
  });
  it('waits for Discord cooldown before retrying', async () => {
    const state = setup(1);
    const started = Date.now();
    vi.mocked(state.gateway.move).mockResolvedValueOnce({ status: 'failed', reason: 'rate_limited', retryAfterMs: 2500 })
      .mockImplementationOnce(async () => {
        expect(Date.now() - started).toBeGreaterThanOrEqual(2500);
        return { status: 'moved', reason: null };
      });
    await state.run();
    expect(state.gateway.move).toHaveBeenCalledTimes(2);
    expect(state.repository.jobs.get(state.input.id)!.status).toBe('Completed');
  });
  it('waits and retries rate limits while scanning', async () => {
    const state = setup(0);
    vi.mocked(state.gateway.scan).mockRejectedValueOnce(new MoveRetry(2000));
    await state.run();
    expect(state.gateway.scan).toHaveBeenCalledTimes(3);
    expect(state.repository.jobs.get(state.input.id)!.status).toBe('Completed');
  });
  it('reconciles an unknown result at destination without sending another move', async () => {
    const state = setup(1);
    vi.mocked(state.gateway.move).mockResolvedValue({ status: 'unknown', reason: 'outcome_unknown' });
    vi.mocked(state.gateway.scan).mockImplementation(async () => ({ ...empty(), resolved: [{ userId: 'user0', status: 'skipped', reason: 'already_at_destination' }] }));
    await state.run();
    expect(state.gateway.move).toHaveBeenCalledTimes(3);
    expect(state.repository.jobs.get(state.input.id)!.members[0]).toMatchObject({ status: 'moved', reason: 'verified_at_destination' });
    expect(state.repository.jobs.get(state.input.id)!.status).toBe('Completed');
  });
  it('does not claim completion if verification is unavailable', async () => {
    const state = setup(1);
    vi.mocked(state.gateway.scan).mockResolvedValue({ ...empty(), unverified: ['user0'] });
    await state.run();
    expect(state.gateway.scan).toHaveBeenCalledTimes(5);
    expect(state.repository.jobs.get(state.input.id)).toMatchObject({ status: 'Interrupted', reason: 'verification_failed', verification: { unverified: ['user0'] } });
  });
  it('bounds endless new arrivals to five rounds', async () => {
    const state = setup(0);
    let next = 0;
    vi.mocked(state.gateway.scan).mockImplementation(async () => ({ ...empty(), remaining: [{ userId: `arrival${next++}`, sourceId: 'a' }] }));
    await state.run();
    expect(state.gateway.scan).toHaveBeenCalledTimes(5);
    expect(state.repository.jobs.get(state.input.id)).toMatchObject({ status: 'Interrupted', reason: 'round_limit' });
  });
  it('refuses cooldowns exceeding the job deadline', async () => {
    const state = setup(1);
    vi.mocked(state.gateway.move).mockResolvedValueOnce({ status: 'failed', reason: 'rate_limited', retryAfterMs: 120000 });
    await state.run();
    expect(state.repository.jobs.get(state.input.id)).toMatchObject({ status: 'Interrupted', reason: 'time_limit' });
    expect(state.gateway.move).toHaveBeenCalledOnce();
  });
  it.each(['destination_full', 'missing_permissions', 'channel_unavailable'])('stops on shared failure %s', async reason => {
    const state = setup();
    vi.mocked(state.gateway.move).mockResolvedValueOnce({ status: 'failed', reason });
    await state.run();
    expect(state.gateway.move).toHaveBeenCalledOnce();
    expect(state.repository.jobs.get(state.input.id)).toMatchObject({ status: 'Interrupted', reason, verification: null });
  });
  it('reserves a guild synchronously and rejects competing jobs', async () => {
    const state = setup();
    const first = state.service.run(state.input, state.gateway, state.notify);
    await expect(state.service.run(moveInput(), state.gateway, state.notify)).rejects.toThrow('đang có');
    await settle(first);
  });
  it.each(['expiry', 'permission', 'create'])('never moves when %s fails before starting', async failure => {
    const state = setup();
    if (failure === 'expiry') state.input.snapshotAt = Date.now() - 61000;
    if (failure === 'permission') vi.mocked(state.gateway.validate).mockRejectedValue(new Error('permission'));
    if (failure === 'create') state.repository.create.mockRejectedValue(new Error('commit unknown'));
    await expect(state.run()).rejects.toThrow();
    expect(state.gateway.move).not.toHaveBeenCalled();
  });
  it.each(['enqueue', 'processing', 'outcome', 'verify'])('stops after an audit %s failure', async operation => {
    const state = setup();
    if (operation === 'enqueue') {
      vi.mocked(state.gateway.move).mockResolvedValueOnce({ status: 'failed', reason: 'discord_unavailable' });
    }
    state.repository[operation as 'enqueue'].mockRejectedValueOnce(new Error('disk error'));
    await state.run();
    expect(state.repository.jobs.get(state.input.id)!.status).toBe('Interrupted');
    if (operation === 'processing') expect(state.gateway.move).not.toHaveBeenCalled();
    if (operation === 'enqueue' || operation === 'outcome') expect(state.gateway.move).toHaveBeenCalledOnce();
  });
  it('stops before any move when progress delivery fails unexpectedly', async () => {
    const state = setup();
    state.notify.mockRejectedValueOnce(new Error('expired webhook'));
    await state.run();
    expect(state.gateway.move).not.toHaveBeenCalled();
    expect(state.repository.jobs.get(state.input.id)).toMatchObject({ status: 'Interrupted', reason: 'progress_delivery_failed' });
  });
  it.each([10008, 10062, 50027])('continues moving and completes when ephemeral progress reply is dismissed or expires (%s)', async code => {
    const state = setup(3);
    state.notify.mockRejectedValueOnce(Object.assign(new Error('Unknown Message'), { code }));
    await state.run();
    expect(state.gateway.move).toHaveBeenCalledTimes(3);
    expect(state.gateway.scan).toHaveBeenCalledTimes(2);
    expect(state.notify).toHaveBeenCalledOnce();
    expect(state.errors).toHaveBeenCalledOnce();
    expect(state.repository.jobs.get(state.input.id)).toMatchObject({ status: 'Completed', verification: { remaining: [], unverified: [] } });
  });
  it('aborts retry waits promptly on shutdown and refuses new work', async () => {
    const state = setup();
    vi.mocked(state.gateway.move).mockResolvedValueOnce({ status: 'failed', reason: 'rate_limited', retryAfterMs: 60000 });
    const running = state.service.run(state.input, state.gateway, state.notify);
    await vi.advanceTimersByTimeAsync(1);
    await state.service.stop();
    await running;
    expect(state.gateway.move).toHaveBeenCalledOnce();
    expect(state.repository.jobs.get(state.input.id)).toMatchObject({ status: 'Interrupted', reason: 'gateway_or_shutdown' });
    await expect(state.service.run(moveInput(), state.gateway, state.notify)).rejects.toThrow('đang dừng');
  });
  it('does not start another person after gateway loss', async () => {
    const state = setup();
    vi.mocked(state.gateway.move).mockImplementationOnce(async () => {
      vi.mocked(state.gateway.ready).mockReturnValue(false);
      return { status: 'moved', reason: null };
    });
    await state.run();
    expect(state.gateway.move).toHaveBeenCalledOnce();
    expect(state.repository.jobs.get(state.input.id)!.status).toBe('Interrupted');
  });
  it('waits for an in-flight move during shutdown and starts no further member', async () => {
    const state = setup();
    let release!: () => void;
    vi.mocked(state.gateway.move).mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ status: 'moved', reason: null });
    }));
    const running = state.service.run(state.input, state.gateway, state.notify);
    await vi.advanceTimersByTimeAsync(1);
    expect(release).toBeTypeOf('function');
    const stopping = state.service.stop();
    release();
    await stopping;
    await running;
    expect(state.gateway.move).toHaveBeenCalledOnce();
    expect(state.repository.jobs.get(state.input.id)!.members.map(member => member.status)).toEqual(['moved', 'failed', 'failed']);
  });
  it('stops before another request if a move runs past the time budget', async () => {
    const state = setup();
    vi.mocked(state.gateway.move).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 120001);
      return { status: 'moved', reason: null };
    });
    await state.run();
    expect(state.gateway.move).toHaveBeenCalledOnce();
    expect(state.repository.jobs.get(state.input.id)).toMatchObject({ status: 'Interrupted', reason: 'time_limit' });
  });
  it('recovers a transient scan failure before verifying completion', async () => {
    const state = setup();
    vi.mocked(state.gateway.scan).mockRejectedValueOnce(new Error('network failure'));
    await state.run();
    expect(state.gateway.scan).toHaveBeenCalledTimes(3);
    expect(state.repository.jobs.get(state.input.id)!.status).toBe('Completed');
  });
});
