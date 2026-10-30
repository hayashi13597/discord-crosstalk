import type { RelayMutation, RelaySnapshot } from './types.js';

export interface RelayRepository {
  initialize(): Promise<RelaySnapshot>;
  mutate(action: RelayMutation, actorId: string): Promise<RelaySnapshot>;
  setSession?(running: boolean): Promise<RelaySnapshot>;
  prune?(): Promise<void>;
  identify(workerId: number, userId: string): Promise<void>;
  healthy(): Promise<boolean>;
}
