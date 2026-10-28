import type { RelayMutation, RelaySnapshot } from './types.js';

export interface RelayRepository {
  initialize(): Promise<RelaySnapshot>;
  mutate(action: RelayMutation, actorId: string): Promise<RelaySnapshot>;
  identify(workerId: number, userId: string): Promise<void>;
  healthy(): Promise<boolean>;
}
