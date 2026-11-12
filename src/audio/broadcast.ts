import type { AudioRouter } from './router.js';

/** Receives decoded PCM from an external announcer bot and distributes it across active group routers. */
export interface BroadcastSink<T extends string | number = string> {
  begin(sourceTeam: T, userId: string): string | undefined;
  isCurrent(key: string): boolean;
  push(key: string, pcm: Buffer): void;
  end(key: string): void;
}

/** Coordinates one-way announcer bot audio across all active AudioRouters without an extra timer. */
export class BroadcastHub<T extends string | number = string> implements BroadcastSink<T> {
  private routers = new Map<string, AudioRouter<T>>();
  private active = new Map<string, { key: string; sourceTeam: T; userId: string }>();
  private seq = 0;

  attachRouter(groupId: string, router: AudioRouter<T>): void {
    this.routers.set(groupId, router);
    for (const source of this.active.values()) router.beginBroadcast(source.key, source.sourceTeam);
  }

  detachRouter(groupId: string): void {
    const router = this.routers.get(groupId);
    if (!router) return;
    this.routers.delete(groupId);
    for (const key of this.active.keys()) router.endBroadcast(key);
  }

  begin(sourceTeam: T, userId: string): string {
    for (const existing of this.active.values()) {
      if (existing.sourceTeam === sourceTeam && existing.userId === userId) return existing.key;
    }
    const key = `${String(sourceTeam)}:${userId}:${++this.seq}`;
    this.active.set(key, { key, sourceTeam, userId });
    for (const router of this.routers.values()) router.beginBroadcast(key, sourceTeam);
    return key;
  }

  isCurrent(key: string): boolean { return this.active.has(key); }

  push(key: string, pcm: Buffer): void {
    if (!this.active.has(key)) return;
    for (const router of this.routers.values()) router.pushBroadcast(key, pcm);
  }

  end(key: string): void {
    if (!this.active.delete(key)) return;
    for (const router of this.routers.values()) router.endBroadcast(key);
  }

  clear(): void {
    for (const key of [...this.active.keys()]) this.end(key);
    this.routers.clear();
  }
}
