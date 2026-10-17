import { performance } from 'node:perf_hooks';
import type { Team } from '../types.js';

export const FRAME_MS = 20;
export const FRAME_SAMPLES = 960;
export const CHANNELS = 2;
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;

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
  const output = Buffer.alloc(FRAME_BYTES);
  const gain = frames.length === 1 ? singleGain : mixGain;
  for (let offset = 0; offset < FRAME_BYTES; offset += 2) {
    let sample = 0;
    for (const frame of frames) sample += frame.readInt16LE(offset) * gain;
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), offset);
  }
  return output;
}

interface Source { userId: string; epoch: number; queue: FrameQueue; remainder: Buffer }

export class AudioRouter<T extends string | number = Team> {
  private teamIds: T[];
  private leaders: Record<T, string | null>;
  private available = new Set<T>();
  private sources = new Map<T, Source>();
  private epochs = new Map<T, number>();
  private outputs = new Map<T, Output>();
  private timer?: NodeJS.Timeout;
  private lastTick?: number;

  constructor(private channels: Record<T, string>, private settings: AudioSettings,
    private clock: () => number = () => performance.now(), private onFault?: (error: unknown) => void) {
    this.teamIds = Object.keys(channels).map(key => /^\d+$/.test(key) ? Number(key) : key) as T[];
    this.leaders = Object.fromEntries(this.teamIds.map(team => [team, null])) as Record<T, string | null>;
  }

  attach(team: T, output: Output): void {
    if (!Object.hasOwn(this.channels, team)) throw new Error('Unknown team in router');
    this.outputs.set(team, output);
  }

  detach(team: T): void {
    this.setTransport(team, false);
    this.outputs.delete(team);
  }

  setLeaders(leaders: Record<T, string | null>): void {
    for (const team of this.teamIds) if (this.leaders[team] !== leaders[team]) this.endSource(team);
    this.leaders = { ...leaders };
  }

  setTransport(team: T, ready: boolean): void {
    if (!Object.hasOwn(this.channels, team) || this.available.has(team) === ready) return;
    if (ready) this.available.add(team);
    else { this.available.delete(team); this.endSource(team); }
    this.outputs.get(team)?.setReady(ready);
  }

  beginSource(team: T, userId: string, channelId: string | null, isBot: boolean): number | undefined {
    if (!this.available.has(team) || isBot || this.leaders[team] !== userId || channelId !== this.channels[team]) return undefined;
    const existing = this.sources.get(team);
    if (existing?.userId === userId) return existing.epoch;
    this.endSource(team);
    const epoch = (this.epochs.get(team) ?? 0) + 1;
    this.epochs.set(team, epoch);
    this.sources.set(team, { userId, epoch, queue: new FrameQueue(this.settings.jitterMs, this.settings.maxQueueMs), remainder: Buffer.alloc(0) });
    return epoch;
  }

  isCurrent(team: T, epoch: number): boolean {
    const source = this.sources.get(team);
    return this.available.has(team) && source?.epoch === epoch && source.userId === this.leaders[team];
  }

  endSource(team: T, epoch?: number): void {
    if (epoch !== undefined && this.sources.get(team)?.epoch !== epoch) return;
    this.sources.delete(team);
    this.epochs.set(team, (this.epochs.get(team) ?? 0) + 1);
    // Mixed packets may already include the revoked voice: flush destination resources too.
    for (const dest of this.teamIds) if (dest !== team) this.outputs.get(dest)?.reset();
  }

  push(team: T, epoch: number, pcm: Buffer): void {
    if (!this.isCurrent(team, epoch)) return;
    const source = this.sources.get(team)!;
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
      for (const source of this.sources.values()) { source.queue.clear(); source.remainder = Buffer.alloc(0); }
      for (const output of this.outputs.values()) output.reset();
    }
    this.lastTick = now;
    const frames = new Map<T, Buffer>();
    for (const [team, source] of this.sources) {
      const frame = source.queue.take(now);
      if (frame) frames.set(team, frame);
    }
    for (const team of this.available) {
      const incoming = [...frames].filter(([source]) => source !== team).map(([, pcm]) => pcm);
      this.outputs.get(team)?.write(mixFrames(incoming, this.settings.singleGain, this.settings.mixGain));
    }
  }

  start(): void {
    this.timer ??= setInterval(() => {
      try { this.tick(); }
      catch (error) {
        try { this.stop(); } finally { this.onFault?.(error); }
      }
    }, FRAME_MS);
  }
  stop(): void {
    clearInterval(this.timer);
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
