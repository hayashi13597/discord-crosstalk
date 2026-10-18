import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceMoveService, RetryMove, type MoveGateway } from '../src/voice-moves.js';
import { moveCounts } from '../src/voice-move-types.js';
import { MemoryMoves, moveInput } from './voice-move-helpers.js';

afterEach(() => vi.useRealTimers());
function setup(count = 3) {
  const repository = new MemoryMoves();
  const errors = vi.fn();
  const service = new VoiceMoveService(repository, errors);
  const input = moveInput(count);
  const gateway: MoveGateway = { ready: vi.fn(() => true), validate: vi.fn(async () => {}),
    move: vi.fn(async member => {
      expect(repository.jobs.get(input.id)!.members.find(value => value.userId === member.userId)!.status).toBe('processing');
      return { status: 'moved' as const, reason: null };
    }) };
  const notify = vi.fn(async () => {});
  return { repository, errors, service, input, gateway, notify, run: () => service.run(input, gateway, notify) };
}
describe('durable mass voice move worker', () => {
  it('writes before every move, runs sequentially and reports exact partial counts', async () => {
    const state = setup();
    vi.mocked(state.gateway.move)
      .mockResolvedValueOnce({ status: 'moved', reason: null })
      .mockResolvedValueOnce({ status: 'skipped', reason: 'left_sources' })
      .mockResolvedValueOnce({ status: 'failed', reason: 'discord_50013' });
    await state.run();
    const job = (await state.repository.get(state.input.id, 'guild'))!;
    expect(job.status).toBe('Partially Completed');
    expect(moveCounts(job)).toEqual({ total: 3, moved: 1, skipped: 1, failed: 1, pending: 0 });
    expect(state.gateway.move).toHaveBeenCalledTimes(3);
    expect(state.notify.mock.calls.length).toBe(2);
  });
  it('reserves the guild before permission/DB awaits and rejects a second job', async () => {
    const state = setup();
    const first = state.run();
    await expect(state.service.run(moveInput(), state.gateway, state.notify)).rejects.toThrow('đang có');
    await first;
    expect(state.repository.create).toHaveBeenCalledOnce();
    await state.service.run(moveInput(0), state.gateway, state.notify);
  });
  it('never moves when snapshot is stale, permissions fail, or audit creation fails', async () => {
    for (const failure of ['expiry', 'permission', 'database']) {
      const state = setup();
      if (failure === 'expiry') state.input.snapshotAt = Date.now() - 61000;
      if (failure === 'permission') vi.mocked(state.gateway.validate).mockRejectedValue(new Error('permission'));
      if (failure === 'database') state.repository.create.mockRejectedValue(new Error('commit unknown'));
      await expect(state.run()).rejects.toThrow();
      expect(state.gateway.move).not.toHaveBeenCalled();
    }
  });
  it('rechecks the session deadline after permission validation and after persisting the job', async () => {
    vi.useFakeTimers();
    for (const during of ['validation', 'commit']) {
      const state = setup();
      const confirmBy = Date.now() + 1000;
      if (during === 'validation') vi.mocked(state.gateway.validate).mockImplementationOnce(async () => { vi.setSystemTime(confirmBy + 1); });
      else {
        const create = state.repository.create.getMockImplementation()!;
        state.repository.create.mockImplementationOnce(async input => { await create(input); vi.setSystemTime(confirmBy + 1); });
      }
      const task = state.service.run(state.input, state.gateway, state.notify, confirmBy);
      if (during === 'validation') await expect(task).rejects.toThrow('hết hạn');
      else { await task; expect(state.repository.jobs.get(state.input.id)!.status).toBe('Interrupted'); }
      expect(state.gateway.move).not.toHaveBeenCalled();
    }
  });
  it('stops before the next user when outcome persistence fails, retaining an unknown result', async () => {
    const state = setup();
    state.repository.outcome.mockRejectedValueOnce(new Error('database offline'));
    await state.run();
    expect(state.gateway.move).toHaveBeenCalledTimes(1);
    const job = (await state.repository.get(state.input.id, 'guild'))!;
    expect(job.status).toBe('Interrupted');
    expect(job.members.map(member => member.status)).toEqual(['unknown', 'failed', 'failed']);
    expect(moveCounts(job)).toEqual({ total: 3, moved: 0, skipped: 0, failed: 3, pending: 0 });
  });
  it('does not send a move if writing processing fails', async () => {
    const state = setup();
    state.repository.processing.mockRejectedValueOnce(new Error('write failed'));
    await state.run();
    expect(state.gateway.move).not.toHaveBeenCalled();
    expect(state.repository.jobs.get(state.input.id)!.status).toBe('Interrupted');
  });
  it('waits on a refused rate limit and re-enters eligibility checks', async () => {
    vi.useFakeTimers();
    const state = setup(1);
    vi.mocked(state.gateway.move).mockRejectedValueOnce(new RetryMove(2000));
    const task = state.run();
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.gateway.move).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await task;
    expect(state.gateway.move).toHaveBeenCalledTimes(2);
    expect(state.repository.jobs.get(state.input.id)!.status).toBe('Completed');
  });
  it('interrupts after gateway loss without rolling back earlier successes', async () => {
    const state = setup();
    vi.mocked(state.gateway.move).mockImplementationOnce(async () => {
      vi.mocked(state.gateway.ready).mockReturnValue(false);
      return { status: 'moved', reason: null };
    });
    await state.run();
    const job = state.repository.jobs.get(state.input.id)!;
    expect(job.status).toBe('Interrupted');
    expect(job.members.map(member => member.status)).toEqual(['moved', 'failed', 'failed']);
  });
  it('aborts a rate-limit wait on shutdown and refuses new work', async () => {
    vi.useFakeTimers();
    const state = setup();
    vi.mocked(state.gateway.move).mockRejectedValueOnce(new RetryMove(60000));
    const task = state.run();
    await vi.advanceTimersByTimeAsync(1);
    await state.service.stop();
    await task;
    expect(state.gateway.move).toHaveBeenCalledTimes(1);
    expect(state.repository.jobs.get(state.input.id)!.status).toBe('Interrupted');
    await expect(state.run()).rejects.toThrow('đang dừng');
  });
  it('waits for an in-flight move to settle on shutdown and starts no further members', async () => {
    const state = setup();
    let release!: () => void;
    vi.mocked(state.gateway.move).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ status: 'moved', reason: null }); }));
    const task = state.run();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const stopping = state.service.stop();
    release();
    await stopping; await task;
    expect(state.gateway.move).toHaveBeenCalledOnce();
    expect(state.repository.jobs.get(state.input.id)!.members.map(member => member.status)).toEqual(['moved', 'failed', 'failed']);
  });
  it('continues when ephemeral progress delivery fails', async () => {
    const state = setup();
    state.notify.mockRejectedValue(new Error('expired webhook'));
    await state.run();
    expect(state.repository.jobs.get(state.input.id)!.status).toBe('Completed');
    expect(state.gateway.move).toHaveBeenCalledTimes(3);
  });
});
