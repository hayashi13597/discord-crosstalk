import { describe, expect, it, vi, afterEach } from 'vitest';
import { AudioRouter, FrameQueue, FRAME_BYTES, mixFrames, type Output } from '../src/audio/router.js';
import { createCodec } from '../src/audio/codec.js';
import { LatestPacketStream } from '../src/audio/output.js';
const TEAMS = [1, 2, 3] as const;
type Team = (typeof TEAMS)[number];

const pcm = (value: number) => {
  const result = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < result.length; i += 2) result.writeInt16LE(value, i);
  return result;
};
function setup(jitterMs = 0) {
  let now = 0;
  const channels = { 1: 'channel1', 2: 'channel2', 3: 'channel3' };
  const router = new AudioRouter(channels, { jitterMs, maxQueueMs: 200, singleGain: 1, mixGain: 0.5 }, () => now);
  const output = () => ({ write: vi.fn<(pcm: Buffer | undefined) => void>(), reset: vi.fn(), setReady: vi.fn<(ready: boolean) => void>(), close: vi.fn() } satisfies Output);
  const outputs = Object.fromEntries(TEAMS.map(team => [team, output()])) as Record<Team, ReturnType<typeof output>>;
  for (const team of TEAMS) { router.attach(team, outputs[team]); router.setTransport(team, true); }
  router.setLeaders({ 1: ['alice'], 2: ['bob'], 3: ['carol'] });
  const epoch = (team: Team) => router.beginSource(team, ['alice', 'bob', 'carol'][team - 1]!, channels[team], false)!;
  return { router, outputs, epoch, advance(ms: number) { now += ms; } };
}

afterEach(() => vi.useRealTimers());
describe('leader-only routing', () => {
  it.each(TEAMS)('routes leader %s only to the other two teams', team => {
    const { router, outputs, epoch } = setup();
    router.push(team, epoch(team), pcm(1200));
    router.tick();
    for (const dest of TEAMS) {
      const frame = outputs[dest].write.mock.calls.at(-1)?.[0] as Buffer | undefined;
      if (dest === team) expect(frame).toBeUndefined();
      else expect(frame?.readInt16LE()).toBe(1200);
    }
  });
  it('rejects members, bot accounts, wrong channels and unavailable transports', () => {
    const { router } = setup();
    expect(router.beginSource(1, 'member', 'channel1', false)).toBeUndefined();
    expect(router.beginSource(1, 'alice', 'channel1', true)).toBeUndefined();
    expect(router.beginSource(1, 'alice', 'channel2', false)).toBeUndefined();
    router.setTransport(1, false);
    expect(router.beginSource(1, 'alice', 'channel1', false)).toBeUndefined();
  });
  it('mixes all three simultaneously without local echo', () => {
    const { router, outputs, epoch } = setup();
    for (const team of TEAMS) router.push(team, epoch(team), pcm(team * 1000));
    router.tick();
    expect(outputs[1].write.mock.calls[0]![0]!.readInt16LE()).toBe(2500);
    expect(outputs[2].write.mock.calls[0]![0]!.readInt16LE()).toBe(2000);
    expect(outputs[3].write.mock.calls[0]![0]!.readInt16LE()).toBe(1500);
  });
  it('revokes buffered audio and late callbacks immediately on replacement/removal', () => {
    const { router, outputs, epoch } = setup();
    const old = epoch(1);
    router.push(1, old, pcm(1000));
    router.setLeaders({ 1: ['new'], 2: ['bob'], 3: ['carol'] });
    expect(outputs[2].reset).toHaveBeenCalled();
    router.push(1, old, pcm(2000));
    expect(router.isCurrent(1, old)).toBe(false);
    router.tick();
    expect(outputs[2].write.mock.calls.at(-1)![0]).toBeUndefined();
    const next = router.beginSource(1, 'new', 'channel1', false)!;
    router.endSource(1, old); // late close from old stream must not revoke new source
    expect(router.isCurrent(1, next)).toBe(true);
    router.push(1, next, pcm(3000));
    router.setLeaders({ 1: [], 2: ['bob'], 3: ['carol'] });
    router.tick();
    expect(outputs[2].write.mock.calls.at(-1)![0]).toBeUndefined();
  });
  it('recovers after disconnect without replaying stale frames; empty team still receives', () => {
    const { router, outputs, epoch } = setup();
    const old = epoch(1);
    router.push(1, old, pcm(1000));
    router.setTransport(1, false);
    router.setTransport(1, true);
    router.push(1, old, pcm(1000));
    router.tick();
    expect(outputs[2].write.mock.calls.at(-1)![0]).toBeUndefined();
    router.setLeaders({ 1: [], 2: ['bob'], 3: ['carol'] });
    router.push(2, epoch(2), pcm(2000));
    router.tick();
    expect(outputs[1].write.mock.calls.at(-1)![0]!.readInt16LE()).toBe(2000);
  });
  it('mixes several leaders from the same team without sending any of them back locally', () => {
    const { router, outputs } = setup();
    router.setTeamLeaders(1, ['alice', 'dave']);
    const alice = router.beginSource(1, 'alice', 'channel1', false)!;
    const dave = router.beginSource(1, 'dave', 'channel1', false)!;
    const bob = router.beginSource(2, 'bob', 'channel2', false)!;
    expect(alice).not.toBe(dave);
    router.push(1, alice, pcm(1000));
    router.push(1, dave, pcm(3000));
    router.push(2, bob, pcm(6000));
    router.tick();
    expect(outputs[1].write.mock.calls.at(-1)![0]!.readInt16LE()).toBe(6000);
    expect(outputs[2].write.mock.calls.at(-1)![0]!.readInt16LE()).toBe(2000);
    expect(outputs[3].write.mock.calls.at(-1)![0]!.readInt16LE()).toBe(5000);
  });
  it('revokes one leader while preserving other captures and rejects late frames after a rejoin', () => {
    const { router, outputs } = setup();
    router.setTeamLeaders(1, ['alice', 'dave']);
    const alice = router.beginSource(1, 'alice', 'channel1', false)!;
    const dave = router.beginSource(1, 'dave', 'channel1', false)!;
    router.push(1, alice, pcm(1000));
    router.push(1, dave, pcm(3000));
    router.setTeamLeaders(1, ['dave']);
    router.push(1, alice, pcm(1000));
    router.tick();
    expect(router.isCurrent(1, alice)).toBe(false);
    expect(router.isCurrent(1, dave)).toBe(true);
    expect(outputs[2].write.mock.calls.at(-1)![0]!.readInt16LE()).toBe(3000);
    router.setTeamLeaders(1, ['alice', 'dave']);
    const rejoined = router.beginSource(1, 'alice', 'channel1', false)!;
    router.endSource(1, alice);
    expect(router.isCurrent(1, rejoined)).toBe(true);
    router.setTransport(1, false);
    expect(router.isCurrent(1, rejoined)).toBe(false);
    expect(router.isCurrent(1, dave)).toBe(false);
    router.setTransport(1, true);
    router.push(1, rejoined, pcm(1000));
    router.push(1, dave, pcm(3000));
    router.tick();
    expect(outputs[2].write.mock.calls.at(-1)![0]).toBeUndefined();
  });
  it('drops backlog after an event loop stall and releases output timers', () => {
    vi.useFakeTimers();
    const { router, outputs, epoch, advance } = setup();
    router.tick();
    router.push(1, epoch(1), pcm(1000));
    advance(500);
    router.tick();
    expect(outputs[2].write.mock.calls.at(-1)![0]).toBeUndefined();
    router.start();
    expect(vi.getTimerCount()).toBe(1);
    router.stop();
    expect(vi.getTimerCount()).toBe(0);
    for (const team of TEAMS) expect(outputs[team].close).toHaveBeenCalledOnce();
  });
  it('splits decoded PCM into 20ms frames without repeating old samples', () => {
    const { router, outputs, epoch } = setup();
    const version = epoch(1);
    const frame = pcm(123);
    router.push(1, version, frame.subarray(0, 100));
    router.tick();
    expect(outputs[2].write.mock.calls.at(-1)![0]).toBeUndefined();
    router.push(1, version, frame.subarray(100));
    router.tick();
    expect(outputs[2].write.mock.calls.at(-1)![0]!.equals(frame)).toBe(true);
    router.tick();
    expect(outputs[2].write.mock.calls.at(-1)![0]).toBeUndefined();
  });
});

describe('bounded jitter queue and mixing', () => {
  it('prebuffers 60ms and drops frames over 200ms old', () => {
    const queue = new FrameQueue(60, 200);
    queue.push(pcm(1), 0);
    expect(queue.take(59)).toBeUndefined();
    expect(queue.take(60)?.readInt16LE()).toBe(1);
    expect(queue.take(80)).toBeUndefined();
    queue.push(pcm(2), 100);
    expect(queue.take(301)).toBeUndefined();
  });
  it('drops the oldest frames on overflow', () => {
    const queue = new FrameQueue(0, 200);
    for (let i = 0; i < 100; i++) queue.push(pcm(i), 0);
    expect(queue.size).toBe(10);
    expect(queue.take(0)?.readInt16LE()).toBe(90);
  });
  it('limits positive and negative peaks; silence does not reuse audio', () => {
    expect(mixFrames([pcm(32767), pcm(32767)], 1, 0.5)?.readInt16LE()).toBe(32767);
    expect(mixFrames([pcm(-32768), pcm(-32768)], 1, 1)?.readInt16LE()).toBe(-32768);
    expect(mixFrames([pcm(32767)], 2, 1)?.readInt16LE()).toBe(32767);
    expect(mixFrames([], 1, 0.5)).toBeUndefined();
  });
  it('bounds output buffering to the latest Opus packet', () => {
    const stream = new LatestPacketStream();
    for (let i = 0; i < 100; i++) stream.offer(Buffer.from([i]));
    expect(stream.readableLength).toBe(1);
    expect(stream.read()).toEqual(Buffer.from([99]));
    stream.destroy();
  });
  it('encodes and decodes a real Opus frame using the installed codec', () => {
    const encoder = createCodec();
    const decoder = createCodec();
    try {
      const packet = encoder.encode(pcm(500));
      expect(packet.length).toBeGreaterThan(0);
      expect(decoder.decode(packet).length).toBe(FRAME_BYTES);
    } finally { encoder.close(); decoder.close(); }
  });
});

describe('independent relay groups', () => {
  function group(prefix: string) {
    const ids = [1, 2, 3].map(index => `${prefix}${index}`);
    const router = new AudioRouter<string>(Object.fromEntries(ids.map(id => [id, `channel-${id}`])), { jitterMs: 0, maxQueueMs: 200, singleGain: 1, mixGain: 0.5 }, () => 0);
    const outputs = new Map(ids.map(id => [id, { write: vi.fn(), reset: vi.fn(), setReady: vi.fn(), close: vi.fn() }]));
    router.setLeaders(Object.fromEntries(ids.map(id => [id, [`leader-${id}`]])));
    for (const id of ids) { router.attach(id, outputs.get(id)!); router.setTransport(id, true); }
    const feed = (id: string, sample: number) => {
      const epoch = router.beginSource(id, `leader-${id}`, `channel-${id}`, false)!;
      router.push(id, epoch, pcm(sample));
      return epoch;
    };
    return { router, outputs, ids, feed };
  }
  it('mixes six simultaneous leaders only inside their own group', () => {
    const a = group('a');
    const b = group('b');
    a.ids.forEach((id, index) => a.feed(id, (index + 1) * 1000));
    b.ids.forEach((id, index) => b.feed(id, (index + 1) * 100));
    a.router.tick(); b.router.tick();
    expect(a.outputs.get('a1')!.write.mock.calls[0]![0].readInt16LE()).toBe(2500);
    expect(a.outputs.get('a2')!.write.mock.calls[0]![0].readInt16LE()).toBe(2000);
    expect(b.outputs.get('b1')!.write.mock.calls[0]![0].readInt16LE()).toBe(250);
    expect(b.outputs.get('b2')!.write.mock.calls[0]![0].readInt16LE()).toBe(200);
    expect(a.router.beginSource('b1', 'leader-b1', 'channel-b1', false)).toBeUndefined();
    expect(b.router.beginSource('a1', 'leader-a1', 'channel-a1', false)).toBeUndefined();
  });
  it('keeps multiple speakers per team isolated across groups', () => {
    const a = group('a');
    const b = group('b');
    for (const current of [a, b]) {
      const team = current.ids[0]!;
      current.router.setTeamLeaders(team, ['alice', 'dave']);
      for (const userId of ['alice', 'dave']) {
        const epoch = current.router.beginSource(team, userId, `channel-${team}`, false)!;
        current.router.push(team, epoch, pcm(current === a ? 1000 : 200));
      }
      current.router.tick();
      expect(current.outputs.get(team)!.write.mock.calls.at(-1)![0]).toBeUndefined();
    }
    expect(a.outputs.get('a2')!.write.mock.calls.at(-1)![0].readInt16LE()).toBe(1000);
    expect(b.outputs.get('b2')!.write.mock.calls.at(-1)![0].readInt16LE()).toBe(200);
    b.router.stop();
    expect(a.router.beginSource('a1', 'alice', 'channel-a1', false)).toBeDefined();
  });
  it('revokes late frames and closes only the paused group', () => {
    const a = group('a');
    const b = group('b');
    const epoch = b.feed('b1', 200);
    a.feed('a1', 1000);
    for (const output of a.outputs.values()) output.reset.mockClear();
    b.router.setLeaders({ b1: [], b2: ['leader-b2'], b3: ['leader-b3'] });
    b.router.push('b1', epoch, pcm(300));
    b.router.tick();
    expect(b.outputs.get('b2')!.write.mock.calls.at(-1)![0]).toBeUndefined();
    b.router.stop();
    a.router.tick();
    expect(a.outputs.get('a2')!.write.mock.calls.at(-1)![0].readInt16LE()).toBe(1000);
    for (const output of a.outputs.values()) { expect(output.reset).not.toHaveBeenCalled(); expect(output.close).not.toHaveBeenCalled(); }
    expect(b.router.isCurrent('b1', epoch)).toBe(false);
  });
  it('contains an output fault to the group timer', () => {
    vi.useFakeTimers();
    const fault = vi.fn();
    const router = new AudioRouter<string>({ b1: 'channel-b1' }, { jitterMs: 0, maxQueueMs: 200, singleGain: 1, mixGain: 0.5 }, undefined, fault);
    router.attach('b1', { write: () => { throw new Error('output failed'); }, reset: vi.fn(), close: vi.fn(), setReady: vi.fn() });
    router.setTransport('b1', true);
    router.start();
    vi.advanceTimersByTime(20);
    expect(fault).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
