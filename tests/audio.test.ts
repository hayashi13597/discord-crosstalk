import { describe, expect, it, vi, afterEach } from 'vitest';
import { AudioRouter, FrameQueue, FRAME_BYTES, mixFrames, type Output } from '../src/audio/router.js';
import { createCodec } from '../src/audio/codec.js';
import { LatestPacketStream, VoiceOutput } from '../src/audio/output.js';
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
  const output = () => ({ write: vi.fn<Output['write']>(), reset: vi.fn(), setReady: vi.fn<(ready: boolean) => void>(), close: vi.fn() } satisfies Output);
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
  it('shares a single PCM mix across non-speaking listener teams while keeping per-output Opus encoder state continuous', () => {
    const { router, outputs } = setup();
    router.setTeamLeaders(1, ['alice', 'dave']);
    const alice = router.beginSource(1, 'alice', 'channel1', false)!;
    const dave = router.beginSource(1, 'dave', 'channel1', false)!;
    router.push(1, alice, pcm(1000));
    router.push(1, dave, pcm(3000));
    router.tick();
    const mixed2 = outputs[2].write.mock.calls[0]![0];
    const mixed3 = outputs[3].write.mock.calls[0]![0];
    expect(mixed2).toBeDefined();
    expect(mixed2).toBe(mixed3);
    expect(mixed2!.readInt16LE()).toBe(2000);

    // Verify Team 3's Opus stream stays continuous with its own encoder even when Team 2 speaks intermittently.
    const liveRouter = new AudioRouter({ 1: 'c1', 2: 'c2', 3: 'c3' }, { jitterMs: 0, maxQueueMs: 200, singleGain: 1, mixGain: 0.5 }, () => 0);
    const out2 = new VoiceOutput(vi.fn());
    const out3 = new VoiceOutput(vi.fn());
    let stream3: { read(): unknown } | undefined;
    vi.spyOn(out3.player, 'play').mockImplementation(resource => {
      stream3 = resource.playStream;
    });
    liveRouter.attach(2, out2); liveRouter.attach(3, out3);
    liveRouter.setTransport(1, true); liveRouter.setTransport(2, true); liveRouter.setTransport(3, true);
    liveRouter.setLeaders({ 1: ['alice'], 2: ['bob'], 3: ['carol'] });
    const e1 = liveRouter.beginSource(1, 'alice', 'c1', false)!;
    const e2 = liveRouter.beginSource(2, 'bob', 'c2', false)!;
    const refEncoder = createCodec();
    const refDecoder = createCodec();
    const out3Decoder = createCodec();
    try {
      for (let f = 0; f < 30; f++) {
        const frame = Buffer.alloc(FRAME_BYTES);
        for (let i = 0; i < 960; i++) {
          const sample = Math.round(16000 * Math.sin((2 * Math.PI * 440 * (f * 960 + i)) / 48000));
          frame.writeInt16LE(sample, i * 4);
          frame.writeInt16LE(sample, i * 4 + 2);
        }
        liveRouter.push(1, e1, frame);
        if (f === 20) liveRouter.push(2, e2, pcm(0));
        liveRouter.tick();
        const expectedPcm = f === 20 ? mixFrames([frame, pcm(0)], 1, 0.5)! : frame;
        const refOut = refDecoder.decode(refEncoder.encode(expectedPcm));
        const actualOut = out3Decoder.decode(stream3!.read() as Buffer);
        expect(actualOut.equals(refOut)).toBe(true);
      }
    } finally {
      out2.close(); out3.close();
      refEncoder.close(); refDecoder.close(); out3Decoder.close();
    }
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
  it('compensates sub-frame timer drift, bounds multi-frame catch-up, and does not drift fast on early wakeups', () => {
    vi.useFakeTimers();
    const { router, outputs, epoch, advance } = setup();
    const source = epoch(1);
    router.push(1, source, pcm(100));
    router.push(1, source, pcm(200));
    router.push(1, source, pcm(300));
    router.start();
    // Simulate setTimeout firing 8ms late (28ms elapsed instead of 20ms).
    advance(28);
    vi.advanceTimersByTime(20);
    expect(outputs[2].write).toHaveBeenCalledTimes(1);
    expect(outputs[2].write.mock.calls[0]![0]!.readInt16LE()).toBe(100);

    // Next tick is scheduled for t=40 (12ms remaining). Simulate sub-ms early wakeup at t=39.4.
    advance(11.4);
    vi.advanceTimersByTime(12);
    expect(outputs[2].write).toHaveBeenCalledTimes(1);
    // Remaining 0.6ms completes t=40.0 and emits the 2nd frame right on phase.
    advance(0.6);
    vi.advanceTimersByTime(1);
    expect(outputs[2].write).toHaveBeenCalledTimes(2);
    expect(outputs[2].write.mock.calls[1]![0]!.readInt16LE()).toBe(200);

    // Simulate a multi-frame stall (45ms elapsed to t=85): emits only 1 frame and keeps a 20ms cadence.
    advance(45);
    vi.advanceTimersByTime(20);
    expect(outputs[2].write).toHaveBeenCalledTimes(3);
    expect(outputs[2].write.mock.calls[2]![0]!.readInt16LE()).toBe(300);
    advance(19);
    vi.advanceTimersByTime(19);
    expect(outputs[2].write).toHaveBeenCalledTimes(3);
    advance(1);
    vi.advanceTimersByTime(1);
    expect(outputs[2].write).toHaveBeenCalledTimes(4);
    router.stop();
  });
  it('preserves queued voice packets in VoiceOutput when a delayed timer fires at 180ms before AudioPlayer reads', () => {
    vi.useFakeTimers();
    const opusSilence = Buffer.from([0xf8, 0xff, 0xfe]);
    let now = 0;
    const router = new AudioRouter({ 1: 'c1', 2: 'c2' }, { jitterMs: 0, maxQueueMs: 200, singleGain: 1, mixGain: 0.5 }, () => now);
    const out2 = new VoiceOutput(vi.fn());
    let stream2: LatestPacketStream | undefined;
    vi.spyOn(out2.player, 'play').mockImplementation(resource => {
      stream2 = resource.playStream as LatestPacketStream;
    });
    router.attach(2, out2);
    router.setTransport(1, true);
    router.setTransport(2, true);
    router.setLeaders({ 1: ['alice'], 2: ['bob'] });
    const source = router.beginSource(1, 'alice', 'c1', false)!;
    const decoder = createCodec();
    const toneFrame = (frameIndex: number, amplitude: number) => {
      const frame = Buffer.alloc(FRAME_BYTES);
      for (let i = 0; i < 960; i++) {
        const sample = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * (frameIndex * 960 + i)) / 48000));
        frame.writeInt16LE(sample, i * 4);
        frame.writeInt16LE(sample, i * 4 + 2);
      }
      return frame;
    };
    const peak = (buf: Buffer) => {
      let max = 0;
      for (let i = 0; i < buf.length; i += 2) max = Math.max(max, Math.abs(buf.readInt16LE(i)));
      return max;
    };
    try {
      router.start();
      // 6 voice frames arrive across 0..100ms while the router timer is delayed until 180ms (< maxQueueMs = 200ms).
      for (let i = 0; i < 6; i++) {
        now = i * 20;
        router.push(1, source, toneFrame(i, (i + 1) * 3000));
      }
      now = 180;
      vi.advanceTimersByTime(20);

      // Before AudioPlayer reads anything at 180ms, only 1 voice packet was offered (not 6 voice + 3 silence).
      expect(stream2).toBeDefined();
      expect(stream2!.readableLength).toBe(1);
      const peaks: number[] = [];
      const firstPacket = stream2!.read() as Buffer;
      expect(firstPacket.equals(opusSilence)).toBe(false);
      peaks.push(peak(decoder.decode(firstPacket)));

      // Subsequent frames drain at a steady 20ms cadence as AudioPlayer consumes one packet per 20ms tick.
      for (let step = 1; step < 6; step++) {
        now += 20;
        vi.advanceTimersByTime(20);
        expect(stream2!.readableLength).toBe(1);
        const packet = stream2!.read() as Buffer;
        expect(packet.equals(opusSilence)).toBe(false);
        peaks.push(peak(decoder.decode(packet)));
      }
      expect(peaks).toHaveLength(6);
      for (let i = 1; i < peaks.length; i++) expect(peaks[i]!).toBeGreaterThan(peaks[i - 1]!);

      // Trailing silence frames follow only after all 6 voice frames have been consumed.
      now += 20;
      vi.advanceTimersByTime(20);
      expect((stream2!.read() as Buffer).equals(opusSilence)).toBe(true);
      for (let i = 0; i < 4; i++) {
        now += 20;
        vi.advanceTimersByTime(20);
        stream2!.read();
      }

      // Even when 6 frames are queued together before a 180ms timer stall and AudioPlayer has not read yet,
      // the output queue holds voice packets instead of being overwritten by trailing silence.
      const burstStart = now;
      for (let i = 0; i < 6; i++) router.push(1, source, toneFrame(i + 10, (i + 1) * 3000));
      now = burstStart + 180;
      vi.advanceTimersByTime(20);
      expect(stream2!.readableLength).toBe(1);
      now = burstStart + 200;
      vi.advanceTimersByTime(20);
      expect(stream2!.readableLength).toBe(2);
      expect((stream2!.read() as Buffer).equals(opusSilence)).toBe(false);
      expect((stream2!.read() as Buffer).equals(opusSilence)).toBe(false);
    } finally {
      router.stop();
      decoder.close();
    }
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
  it('limits positive and negative peaks, bypasses single-source unity gain, and handles unaligned buffers', () => {
    const single = pcm(1234);
    expect(mixFrames([single], 1, 0.5)).toBe(single);
    expect(mixFrames([pcm(32767), pcm(32767)], 1, 0.5)?.readInt16LE()).toBe(32767);
    expect(mixFrames([pcm(-32768), pcm(-32768)], 1, 1)?.readInt16LE()).toBe(-32768);
    expect(mixFrames([pcm(32767)], 2, 1)?.readInt16LE()).toBe(32767);
    const raw = Buffer.alloc(FRAME_BYTES + 1);
    pcm(1000).copy(raw, 1);
    const unaligned = raw.subarray(1, 1 + FRAME_BYTES);
    expect(mixFrames([unaligned, pcm(1000)], 1, 0.5)?.readInt16LE()).toBe(1000);
    expect(mixFrames([], 1, 0.5)).toBeUndefined();
  });
  it('bounds output buffering to 3 Opus packets (60ms) in FIFO order and supports clean EOF', () => {
    const stream = new LatestPacketStream();
    for (let i = 0; i < 100; i++) stream.offer(Buffer.from([i]));
    expect(stream.readableLength).toBe(3);
    expect(stream.read()).toEqual(Buffer.from([97]));
    expect(stream.read()).toEqual(Buffer.from([98]));
    stream.finish();
    expect(stream.finishedOffering).toBe(true);
    stream.offer(Buffer.from([100]));
    expect(stream.read()).toEqual(Buffer.from([99]));
    expect(stream.read()).toBeNull();
    stream.destroy();
  });
  it('stays idle in silence and stops offering after 5 trailing OPUS_SILENCE frames', () => {
    const onError = vi.fn();
    const out = new VoiceOutput(onError);
    const playSpy = vi.spyOn(out.player, 'play');
    out.setReady(true);
    for (let i = 0; i < 10; i++) out.write(undefined);
    expect(playSpy).not.toHaveBeenCalled();

    out.write(pcm(800));
    expect(playSpy).toHaveBeenCalledOnce();
    // Brief 2-frame pause followed by speech keeps the same resource open without re-playing.
    out.write(undefined);
    out.write(undefined);
    out.write(pcm(900));
    expect(playSpy).toHaveBeenCalledOnce();

    // 5 silence frames close out the burst; subsequent silence ticks stay idle until new speech.
    for (let i = 0; i < 10; i++) out.write(undefined);
    expect(playSpy).toHaveBeenCalledOnce();
    out.write(pcm(1000));
    expect(playSpy).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    out.close();
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
