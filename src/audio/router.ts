import { endianness } from 'node:os';

export const FRAME_MS = 20;
export const FRAME_SAMPLES = 960;
export const CHANNELS = 2;
export const SAMPLE_COUNT = FRAME_SAMPLES * CHANNELS;
export const FRAME_BYTES = SAMPLE_COUNT * 2;
const IS_LITTLE_ENDIAN = endianness() === 'LE';

export interface AudioSettings {
  jitterMs: number;
  maxQueueMs: number;
  singleGain: number;
  mixGain: number;
}
export interface Output {
  setReady(ready: boolean): void;
  reset(): void;
  write(pcm: Buffer | undefined): void;
  close(): void;
}

export class FrameQueue {
  private frames: { pcm: Buffer; at: number }[] = [];
  private readyAt?: number;
  constructor(private jitterMs: number, private maxMs: number) {}
  get size(): number { return this.frames.length; }
  clear(): void { this.frames = []; this.readyAt = undefined; }
  push(pcm: Buffer, at: number): void {
    if (pcm.length !== FRAME_BYTES) throw new Error('Invalid PCM frame length');
    this.expire(at);
    this.readyAt ??= at + this.jitterMs;
    this.frames.push({ pcm: Buffer.from(pcm), at });
    const overflow = this.frames.length - this.maxMs / FRAME_MS;
    if (overflow > 0) this.frames.splice(0, overflow);
  }
  take(now: number): Buffer | undefined {
    this.expire(now);
    if (this.readyAt === undefined || now < this.readyAt) return undefined;
    const frame = this.frames.shift()?.pcm;
    if (!this.frames.length) this.readyAt = undefined;
    return frame;
  }
  private expire(now: number): void {
    while (this.frames[0] && now - this.frames[0].at > this.maxMs) this.frames.shift();
    if (!this.frames.length) this.readyAt = undefined;
  }
}

export function mixFrames(frames: Buffer[], singleGain: number, mixGain: number): Buffer | undefined {
  if (!frames.length) return undefined;
  if (frames.length === 1 && singleGain === 1) return frames[0];
  const output = Buffer.allocUnsafe(FRAME_BYTES);
  const gain = frames.length === 1 ? singleGain : mixGain;
  if (IS_LITTLE_ENDIAN && output.byteOffset % 2 === 0 && frames.every(frame => frame.byteOffset % 2 === 0)) {
    const views = frames.map(frame => new Int16Array(frame.buffer, frame.byteOffset, SAMPLE_COUNT));
    const out = new Int16Array(output.buffer, output.byteOffset, SAMPLE_COUNT);
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      let sample = 0;
      for (let j = 0; j < views.length; j++) sample += views[j]![i]! * gain;
      const rounded = Math.round(sample);
      out[i] = rounded > 32767 ? 32767 : rounded < -32768 ? -32768 : rounded;
    }
    return output;
  }
  for (let offset = 0; offset < FRAME_BYTES; offset += 2) {
    let sample = 0;
    for (const frame of frames) sample += frame.readInt16LE(offset) * gain;
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), offset);
  }
  return output;
}

interface Source { userId: string; epoch: number; queue: FrameQueue; remainder: Buffer }

export class AudioRouter<T extends string | number = number> {
  private teamIds: T[];
  private leaders = new Map<T, Set<string>>();
  private available = new Set<T>();
  private sources = new Map<T, Map<number, Source>>();
  private epochs = new Map<T, number>();
  private outputs = new Map<T, Output>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastTick?: number;

  constructor(private channels: Record<T, string>, private settings: AudioSettings,
    private clock: () => number = () => globalThis.performance.now(), private onFault?: (error: unknown) => void) {
    this.teamIds = Object.keys(channels).map(key => /^\d+$/.test(key) ? Number(key) : key) as T[];
  }

  attach(team: T, output: Output): void {
    if (!Object.hasOwn(this.channels, team)) throw new Error('Unknown team in router');
    this.outputs.set(team, output);
  }

  detach(team: T): void {
    this.setTransport(team, false);
    this.outputs.delete(team);
  }

  setLeaders(leaders: Record<T, readonly string[]>): void {
    for (const team of this.teamIds) this.setTeamLeaders(team, leaders[team] ?? []);
  }

  setTeamLeaders(team: T, userIds: readonly string[]): void {
    if (!Object.hasOwn(this.channels, team)) return;
    const eligible = new Set(userIds);
    this.leaders.set(team, eligible);
    for (const source of this.sources.get(team)?.values() ?? []) {
      if (!eligible.has(source.userId)) this.endSource(team, source.epoch);
    }
  }

  setTransport(team: T, ready: boolean): void {
    if (!Object.hasOwn(this.channels, team) || this.available.has(team) === ready) return;
    if (ready) this.available.add(team);
    else { this.available.delete(team); this.endSource(team); }
    this.outputs.get(team)?.setReady(ready);
  }

  beginSource(team: T, userId: string, channelId: string | null, isBot: boolean): number | undefined {
    if (!this.available.has(team) || isBot || !this.leaders.get(team)?.has(userId) || channelId !== this.channels[team]) return undefined;
    const sources = this.sources.get(team) ?? new Map<number, Source>();
    const existing = [...sources.values()].find(source => source.userId === userId);
    if (existing) return existing.epoch;
    const epoch = (this.epochs.get(team) ?? 0) + 1;
    this.epochs.set(team, epoch);
    sources.set(epoch, { userId, epoch, queue: new FrameQueue(this.settings.jitterMs, this.settings.maxQueueMs), remainder: Buffer.alloc(0) });
    this.sources.set(team, sources);
    return epoch;
  }

  isCurrent(team: T, epoch: number): boolean {
    const source = this.sources.get(team)?.get(epoch);
    return this.available.has(team) && Boolean(source && this.leaders.get(team)?.has(source.userId));
  }

  endSource(team: T, epoch?: number): void {
    const sources = this.sources.get(team);
    if (!sources || (epoch !== undefined && !sources.has(epoch))) return;
    if (epoch === undefined) sources.clear();
    else sources.delete(epoch);
    if (!sources.size) this.sources.delete(team);
    // Mixed packets may already include the revoked voice: flush destination resources too.
    for (const dest of this.teamIds) if (dest !== team) this.outputs.get(dest)?.reset();
  }

  push(team: T, epoch: number, pcm: Buffer): void {
    if (!this.isCurrent(team, epoch)) return;
    const source = this.sources.get(team)!.get(epoch)!;
    // Opus can decode several frames per packet. Keep only a partial frame as remainder.
    if (pcm.length > FRAME_BYTES * 6 || pcm.length % (CHANNELS * 2)) return;
    const combined = source.remainder.length ? Buffer.concat([source.remainder, pcm]) : pcm;
    const now = this.clock();
    let offset = 0;
    while (offset + FRAME_BYTES <= combined.length) {
      source.queue.push(combined.subarray(offset, offset + FRAME_BYTES), now);
      offset += FRAME_BYTES;
    }
    source.remainder = Buffer.from(combined.subarray(offset));
  }

  tick(): void {
    const now = this.clock();
    if (this.lastTick !== undefined && now - this.lastTick > this.settings.maxQueueMs) {
      for (const sources of this.sources.values()) for (const source of sources.values()) {
        source.queue.clear(); source.remainder = Buffer.alloc(0);
      }
      for (const output of this.outputs.values()) output.reset();
    }
    this.lastTick = now;
    const frames: [T, Buffer][] = [];
    const activeTeams = new Set<T>();
    for (const [team, sources] of this.sources) for (const source of sources.values()) {
      const frame = source.queue.take(now);
      if (frame) {
        frames.push([team, frame]);
        activeTeams.add(team);
      }
    }
    if (!frames.length) {
      for (const team of this.available) this.outputs.get(team)?.write(undefined);
      return;
    }
    // Share PCM mixing across all listener teams receiving the same active sources,
    // while each VoiceOutput encodes with its own continuous stateful Opus encoder.
    let sharedAll: Buffer | undefined;
    const allPcm = frames.map(([, pcm]) => pcm);
    for (const team of this.available) {
      const output = this.outputs.get(team);
      if (!output) continue;
      if (!activeTeams.has(team)) {
        sharedAll ??= mixFrames(allPcm, this.settings.singleGain, this.settings.mixGain);
        output.write(sharedAll);
        continue;
      }
      const incoming = frames.filter(([source]) => source !== team).map(([, pcm]) => pcm);
      output.write(mixFrames(incoming, this.settings.singleGain, this.settings.mixGain));
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    let nextAt = this.clock() + FRAME_MS;
    const step = () => {
      this.timer = undefined;
      if (!this.running) return;
      try {
        const now = this.clock();
        if (now - nextAt > this.settings.maxQueueMs) {
          this.tick();
          nextAt = this.clock() + FRAME_MS;
        } else {
          while (this.running && this.clock() >= nextAt) {
            this.tick();
            nextAt += FRAME_MS;
          }
        }
      } catch (error) {
        try { this.stop(); } finally { this.onFault?.(error); }
        return;
      }
      if (!this.running) return;
      const current = this.clock();
      this.timer = setTimeout(step, Math.max(1, Math.ceil(nextAt - current)));
    };
    this.timer = setTimeout(step, FRAME_MS);
  }
  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.sources.clear();
    this.available.clear();
    this.lastTick = undefined;
    let failure: unknown;
    for (const output of this.outputs.values()) {
      try { output.close(); } catch (error) { failure ??= error; }
    }
    if (failure && !this.onFault) throw failure;
  }
}
