import { describe, expect, it, vi } from 'vitest';
import { RelayService } from '../src/relays.js';
import { CommitUncertainError } from '../src/database-errors.js';
import type { RelaySnapshot } from '../src/types.js';
const empty: RelaySnapshot = { groups: [], teams: [], session: false };
function setup() {
  const repository = {
    initialize: vi.fn(async () => structuredClone(empty)),
    mutate: vi.fn(async () => structuredClone(empty)),
    setSession: vi.fn(async (running: boolean) => ({ ...structuredClone(empty), session: running })),
    identify: vi.fn(),
    healthy: vi.fn(),
  };
  const apply = vi.fn(); const fatal = vi.fn();
  return { repository, apply, fatal, service: new RelayService(repository, apply, fatal) };
}
describe('relay configuration publication', () => {
  it('publishes only committed changes and protects its snapshot from mutation', async () => {
    const { service, repository, apply } = setup();
    await service.initialize();
    repository.mutate.mockResolvedValue({ groups: [{ id: 'b', name: 'Bravo', state: 'paused', legacy: false }], teams: [], session: false });
    await service.mutate({ kind: 'group.create', name: 'Bravo' }, 'admin');
    service.snapshot.groups[0]!.name = 'outside-change';
    expect(service.snapshot.groups[0]!.name).toBe('Bravo');
    expect(apply).toHaveBeenCalledTimes(2);
    repository.mutate.mockRejectedValue(new Error('write failed'));
    await expect(service.mutate({ kind: 'group.create', name: 'Charlie' }, 'admin')).rejects.toThrow();
    expect(apply).toHaveBeenCalledTimes(2);
  });
  it('serializes mutations, drains pending operations and rejects new work after stop', async () => {
    const { service, repository } = setup();
    let finish!: (value: RelaySnapshot) => void;
    repository.mutate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = service.mutate({ kind: 'group.create', name: 'B' }, 'admin');
    const second = service.mutate({ kind: 'group.create', name: 'C' }, 'admin');
    await Promise.resolve();
    expect(repository.mutate).toHaveBeenCalledOnce();
    const stopping = service.stop();
    await expect(service.mutate({ kind: 'group.create', name: 'D' }, 'admin')).rejects.toThrow('stopping');
    await expect(service.setSession(true)).rejects.toThrow('stopping');
    finish(empty);
    await Promise.all([first, second, stopping]);
    expect(repository.mutate).toHaveBeenCalledTimes(2);
  });
  it('fails closed on an uncertain commit and retains the previous snapshot', async () => {
    const { service, repository, fatal, apply } = setup();
    repository.mutate.mockRejectedValue(new CommitUncertainError('lost response'));
    await expect(service.mutate({ kind: 'group.create', name: 'B' }, 'admin')).rejects.toThrow();
    expect(fatal).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });
  it('persists session changes serially and fails closed if session commit is uncertain', async () => {
    const { service, repository, fatal, apply } = setup();
    await service.initialize();
    await service.setSession(true);
    expect(repository.setSession).toHaveBeenCalledExactlyOnceWith(true);
    expect(service.snapshot.session).toBe(true);
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ session: true }));

    repository.setSession.mockRejectedValueOnce(new CommitUncertainError('disk I/O lost'));
    await expect(service.setSession(false)).rejects.toThrow();
    expect(fatal).toHaveBeenCalledOnce();
    expect(service.snapshot.session).toBe(true);
  });
});
