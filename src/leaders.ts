import { CommitUncertainError, type LeaderRepository } from './database.js';
import { emptyLeaders, type Leaders, type Team } from './types.js';

export class LeaderService {
  private current = emptyLeaders();
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;
  constructor(private repository: LeaderRepository, private apply: (leaders: Leaders) => void,
    private onUncertain: (error: unknown) => void = () => {}) {}
  get snapshot(): Leaders { return { ...this.current }; }
  async initialize(): Promise<void> {
    this.current = await this.repository.load();
    this.apply(this.snapshot);
  }
  change(team: Team, userId: string | null, actorId: string): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error('Service is stopping'));
    const operation = this.tail.then(async () => {
      const next = await this.repository.change(team, userId, actorId).catch(error => {
        if (error instanceof CommitUncertainError) this.onUncertain(error);
        throw error;
      });
      // No await between applying revocation and publishing the new snapshot.
      this.apply(next);
      this.current = { ...next };
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  async stop(): Promise<void> { this.accepting = false; await this.tail; }
}
