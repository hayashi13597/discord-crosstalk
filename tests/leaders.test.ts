import { describe, expect, it, vi } from 'vitest';
import { LeaderService } from '../src/leaders.js';
import { emptyLeaders } from '../src/types.js';
import { CommitUncertainError } from '../src/database.js';

describe('leader state publication', () => {
  it('restores persisted leaders and applies changes before reporting success', async () => {
    const apply = vi.fn();
    const repository = { load: vi.fn().mockResolvedValue({ 1: 'alice', 2: null, 3: null }), healthy: vi.fn(),
      change: vi.fn().mockResolvedValue({ 1: 'bob', 2: null, 3: null }) };
    const service = new LeaderService(repository, apply);
    await service.initialize();
    expect(service.snapshot[1]).toBe('alice');
    await service.change(1, 'bob', 'admin');
    expect(apply).toHaveBeenLastCalledWith({ 1: 'bob', 2: null, 3: null });
    expect(service.snapshot[1]).toBe('bob');
  });
  it('leaves current relay permissions unchanged when persistence fails', async () => {
    const apply = vi.fn();
    const service = new LeaderService({ load: async () => emptyLeaders(), healthy: async () => false,
      change: async () => { throw new Error('DB down'); } }, apply);
    await service.initialize();
    apply.mockClear();
    await expect(service.change(1, 'alice', 'admin')).rejects.toThrow('DB down');
    expect(apply).not.toHaveBeenCalled();
    expect(service.snapshot).toEqual(emptyLeaders());
  });
  it('serializes concurrent mutations and drains pending changes on shutdown', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const change = vi.fn(async () => { if (++calls === 1) await gate; return emptyLeaders(); });
    const service = new LeaderService({ load: async () => emptyLeaders(), healthy: async () => true, change }, () => {});
    const first = service.change(1, 'alice', 'admin');
    const second = service.change(2, 'bob', 'admin');
    await Promise.resolve();
    expect(change).toHaveBeenCalledTimes(1);
    const stopping = service.stop();
    await expect(service.change(3, 'carol', 'admin')).rejects.toThrow('stopping');
    release();
    await Promise.all([first, second, stopping]);
    expect(change).toHaveBeenCalledTimes(2);
  });
  it('fails closed if the database may have committed but its response was lost', async () => {
    const onUncertain = vi.fn();
    const service = new LeaderService({ load: async () => emptyLeaders(), healthy: async () => true,
      change: async () => { throw new CommitUncertainError(new Error('connection reset')); } }, () => {}, onUncertain);
    await expect(service.change(1, null, 'admin')).rejects.toThrow('commit');
    expect(onUncertain).toHaveBeenCalledOnce();
  });
});
