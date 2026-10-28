import { CommitUncertainError } from './database-errors.js';
import type { RelayRepository } from './relay-repository.js';
import type { RelayMutation, RelaySnapshot } from './types.js';

export class RelayService {
  private current: RelaySnapshot = { groups: [], teams: [] };
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;
  constructor(readonly repository: RelayRepository, private apply: (snapshot: RelaySnapshot) => void,
    private onUncertain: (error: unknown) => void) {}
  get snapshot(): RelaySnapshot { return structuredClone(this.current); }
  async initialize(): Promise<void> { this.publish(await this.repository.initialize()); }
  private publish(next: RelaySnapshot): void {
    // Runtime must use the committed state even when an individual group cannot connect.
    this.current = structuredClone(next);
    this.apply(this.snapshot);
  }
  mutate(action: RelayMutation, actorId: string): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error('Service is stopping'));
    const operation = this.tail.then(async () => {
      const next = await this.repository.mutate(action, actorId).catch(error => {
        if (error instanceof CommitUncertainError) this.onUncertain(error);
        throw error;
      });
      this.publish(next);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  async stop(): Promise<void> { this.accepting = false; await this.tail; }
}
