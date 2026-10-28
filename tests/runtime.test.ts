import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { RelayRuntime } from '../src/runtime.js';
import { loadConfig } from '../src/config.js';
import type { RelaySnapshot } from '../src/types.js';

const mocks = vi.hoisted(() => ({ workers: new Map<number, { configure: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>() }));
vi.mock('../src/bot.js', () => ({ TeamBot: class {
  configure = vi.fn(); refresh = vi.fn(); start = vi.fn(); stop = vi.fn(async () => {}); status = vi.fn(() => ({}));
  constructor(...args: unknown[]) { mocks.workers.set((args[5] as { workerId: number }).workerId, this); }
} }));
const config = loadConfig({
  GUILD_ID: '123456789012345678', LEADER_ROLE_ID: '123456789012345680', BOT_TOKEN_1: 'a', BOT_TOKEN_2: 'b', BOT_TOKEN_3: 'c', BOT_TOKEN_4: 'd', BOT_TOKEN_5: 'e', BOT_TOKEN_6: 'f',
});
const initial: RelaySnapshot = {
  groups: [{ id: 'a', name: 'Group A', state: 'active', legacy: true }, { id: 'b', name: 'Bravo', state: 'active', legacy: false }],
  teams: [1, 2, 3, 4, 5, 6].map(workerId => ({ id: `team-${workerId}`, groupId: workerId <= 3 ? 'a' : 'b', channelId: `channel-${workerId}`, workerId })),
};
const active: RelayRuntime[] = [];
function setup() {
  vi.useFakeTimers();
  const runtime = new RelayRuntime(config, { error: vi.fn() } as unknown as Logger, vi.fn(), vi.fn());
  active.push(runtime);
  const snapshot = structuredClone(initial);
  runtime.apply(snapshot);
  runtime.setSession(true);
  vi.clearAllMocks();
  return { runtime, snapshot };
}
afterEach(async () => { await Promise.all(active.splice(0).map(runtime => runtime.stop())); mocks.workers.clear(); vi.useRealTimers(); });
describe('group runtime reconciliation', () => {
  it('pauses only Group B and leaves Group A connections untouched', () => {
    const { runtime, snapshot } = setup();
    expect(vi.getTimerCount()).toBe(2);
    snapshot.groups[1]!.state = 'paused';
    runtime.apply(snapshot);
    expect(vi.getTimerCount()).toBe(1);
    for (const id of [1, 2, 3]) expect(mocks.workers.get(id)!.configure).not.toHaveBeenCalled();
    for (const id of [4, 5, 6]) expect(mocks.workers.get(id)!.configure).toHaveBeenLastCalledWith(`team-${id}`, expect.anything(), `channel-${id}`, false);
  });
  it('applies group metadata without rebuilding worker connections', () => {
    const { runtime, snapshot } = setup();
    snapshot.groups[1]!.name = 'Renamed';
    runtime.apply(snapshot);
    for (const worker of mocks.workers.values()) expect(worker.configure).not.toHaveBeenCalled();
    expect(mocks.workers.get(4)!.refresh).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(2);
  });
  it('removes B workers and timer without changing A', () => {
    const { runtime, snapshot } = setup();
    snapshot.groups.pop();
    snapshot.teams = snapshot.teams.filter(team => team.groupId === 'a');
    runtime.apply(snapshot);
    expect(vi.getTimerCount()).toBe(1);
    for (const id of [1, 2, 3]) expect(mocks.workers.get(id)!.configure).not.toHaveBeenCalled();
    for (const id of [4, 5, 6]) expect(mocks.workers.get(id)!.configure).toHaveBeenCalledWith(`idle-${id}`, expect.anything(), null, false);
  });
  it('contains a group reconciliation failure without reconfiguring Group A', () => {
    const { runtime, snapshot } = setup();
    mocks.workers.get(4)!.configure.mockImplementationOnce(() => { throw new Error('worker failure'); });
    snapshot.groups[1]!.state = 'paused';
    expect(() => runtime.apply(snapshot)).not.toThrow();
    expect(runtime.groupError('b')).toBe('AUDIO_ERROR');
    expect(runtime.groupError('a')).toBeNull();
    for (const id of [1, 2, 3]) expect(mocks.workers.get(id)!.configure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    runtime.apply(snapshot);
    expect(runtime.groupError('b')).toBeNull();
  });
  it('does not disable a worker reassigned to another group when an older group router fails', () => {
    const { runtime, snapshot } = setup();
    snapshot.teams = snapshot.teams.filter(team => team.workerId !== 4);
    runtime.apply(snapshot);
    const routerB = mocks.workers.get(5)!.configure.mock.calls.at(-1)![1];
    snapshot.groups.push({ id: 'c', name: 'Charlie', state: 'active', legacy: false });
    snapshot.teams.push({ id: 'team-c1', groupId: 'c', channelId: 'channel-c1', workerId: 4 });
    runtime.apply(snapshot);
    vi.clearAllMocks();
    routerB.attach('team-5', { write: () => { throw new Error('B output fault'); }, close: vi.fn(), reset: vi.fn(), setReady: vi.fn() });
    routerB.setTransport('team-5', true);
    vi.advanceTimersByTime(20);
    expect(runtime.groupError('b')).toBe('AUDIO_ERROR');
    expect(runtime.groupError('c')).toBeNull();
    expect(mocks.workers.get(4)!.configure).not.toHaveBeenCalled();
    for (const id of [1, 2, 3]) expect(mocks.workers.get(id)!.configure).not.toHaveBeenCalled();
  });
  it('waits for start, preserves paused groups and disconnects on stop', () => {
    vi.useFakeTimers();
    const runtime = new RelayRuntime(config, { error: vi.fn() } as unknown as Logger, vi.fn(), vi.fn());
    active.push(runtime);
    const snapshot = structuredClone(initial);
    snapshot.groups[1]!.state = 'paused';
    runtime.apply(snapshot);
    runtime.start();
    expect(runtime.sessionRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    for (const worker of mocks.workers.values()) expect(worker.configure.mock.calls.at(-1)![3]).toBe(false);
    runtime.setSession(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(mocks.workers.get(1)!.configure.mock.calls.at(-1)![3]).toBe(true);
    expect(mocks.workers.get(4)!.configure.mock.calls.at(-1)![3]).toBe(false);
    vi.clearAllMocks();
    runtime.setSession(true);
    for (const worker of mocks.workers.values()) expect(worker.configure).not.toHaveBeenCalled();
    runtime.setSession(false);
    expect(vi.getTimerCount()).toBe(0);
    for (const worker of mocks.workers.values()) expect(worker.configure.mock.calls.at(-1)![3]).toBe(false);
    snapshot.groups[1]!.state = 'active';
    runtime.apply(snapshot);
    expect(mocks.workers.get(4)!.configure.mock.calls.at(-1)![3]).toBe(false);
  });
  it('starts all configured gateways and drains them on shutdown', async () => {
    const { runtime } = setup();
    runtime.start();
    for (const worker of mocks.workers.values()) expect(worker.start).toHaveBeenCalledOnce();
    await runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
    for (const worker of mocks.workers.values()) expect(worker.stop).toHaveBeenCalledOnce();
  });
});
