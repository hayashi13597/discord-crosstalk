import type { Interaction } from 'discord.js';
import type { Logger } from 'pino';
import { AudioRouter } from './audio/router.js';
import { TeamBot, type BotStatus } from './bot.js';
import type { Config } from './config.js';
import type { RelayGroup, RelaySnapshot } from './types.js';

interface GroupRuntime { signature: string; router: AudioRouter<string> }

export class RelayRuntime {
  private groups = new Map<string, GroupRuntime>();
  private errors = new Map<string, string>();
  private workers = new Map<number, TeamBot<string>>();
  private snapshot: RelaySnapshot = { groups: [], teams: [] };
  private idle: AudioRouter<string>;
  private stopped = false;
  private session = false;
  get sessionRunning(): boolean { return this.session; }
  setSession(running: boolean): void {
    if (this.stopped || running === this.session) return;
    this.session = running;
    if (this.snapshot.session !== undefined) this.snapshot.session = running;
    this.apply(this.snapshot);
  }
  constructor(private config: Config, private log: Logger, onInteraction: (interaction: Interaction) => void,
    identify: (workerId: number, userId: string) => Promise<void>) {
    this.idle = new AudioRouter<string>({}, config);
    for (const worker of config.workers) {
      this.workers.set(worker.id, new TeamBot(`idle-${worker.id}`, config, this.idle, log,
        worker.id === 1 ? onInteraction : undefined,
        { workerId: worker.id, token: worker.token, channelId: null, active: false, onIdentity: userId => identify(worker.id, userId) }));
    }
  }

  apply(snapshot: RelaySnapshot): void {
    if (this.stopped) return;
    const old = this.snapshot;
    this.snapshot = structuredClone(snapshot);
    if (snapshot.session !== undefined) this.session = snapshot.session;
    const changed = new Set<string>();
    const signature = (group: RelayGroup) => JSON.stringify([this.session, group.state,
      snapshot.teams.filter(team => team.groupId === group.id).map(team => [team.id, team.channelId, team.workerId])]);
    for (const [id, group] of this.groups) {
      const next = snapshot.groups.find(group => group.id === id);
      if (!next || signature(next) !== group.signature || this.errors.has(id)) changed.add(id);
    }
    for (const group of snapshot.groups) if (!this.groups.has(group.id)) changed.add(group.id);
    for (const id of changed) {
      try {
        // Revoke before closing/replacing routers. Only this group is touched.
        for (const team of old.teams.filter(team => team.groupId === id)) {
          this.workers.get(team.workerId)?.configure(`idle-${team.workerId}`, this.idle, null, false);
        }
        this.groups.get(id)?.router.stop();
        this.groups.delete(id);
        this.errors.delete(id);
        const group = snapshot.groups.find(group => group.id === id);
        if (!group) continue;
        const teams = snapshot.teams.filter(team => team.groupId === id);
        const router = new AudioRouter<string>(Object.fromEntries(teams.map(team => [team.id, team.channelId])), this.config, undefined,
          error => this.contain(id, error, old));
        this.groups.set(id, { signature: signature(group), router });
        for (const team of teams) this.workers.get(team.workerId)?.configure(team.id, router, team.channelId, this.session && group.state === 'active');
        if (this.session && group.state === 'active') router.start();
      } catch (error) { this.contain(id, error, old); }
    }
    // Metadata updates leave connections, timers and other groups intact.
    for (const group of snapshot.groups) if (!changed.has(group.id)) {
      try {
        for (const team of snapshot.teams.filter(team => team.groupId === group.id)) this.workers.get(team.workerId)?.refresh();
      } catch (error) { this.contain(group.id, error, old); }
    }
  }

  private contain(id: string, error: unknown, previous: RelaySnapshot): void {
    this.errors.set(id, 'AUDIO_ERROR');
    this.log.error({ group: id, err: error }, 'Relay group failed; other groups continue');
    this.groups.get(id)?.router.stop();
    const workers = new Set([...previous.teams, ...this.snapshot.teams].filter(team => {
      if (team.groupId !== id) return false;
      // A worker from an older topology may now belong to another group.
      const owner = this.snapshot.teams.find(current => current.workerId === team.workerId);
      return !owner || owner.groupId === id;
    }).map(team => team.workerId));
    for (const workerId of workers) {
      try { this.workers.get(workerId)?.configure(`idle-${workerId}`, this.idle, null, false); }
      catch (error) { this.log.error({ group: id, worker: workerId, err: error }, 'Worker cleanup failed'); }
    }
  }

  start(): void { for (const worker of this.workers.values()) worker.start(); }
  workerStatus(id: number): BotStatus<string> | undefined { return this.workers.get(id)?.status(); }
  groupError(id: string): string | null { return this.errors.get(id) ?? null; }
  async stop(): Promise<void> {
    this.stopped = true;
    const closing = [...this.workers.values()].map(worker => worker.stop());
    for (const group of this.groups.values()) group.router.stop();
    this.idle.stop();
    await Promise.allSettled(closing);
  }
}
