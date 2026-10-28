export const voiceSourceOptionNames = Array.from({ length: 25 }, (_, index) => index === 0 ? 'channel' : `channel-${index + 1}`);

export interface MoveSource { id: string; humans: number; bots: number }
export interface MoveMember { userId: string; sourceId: string }
export interface MoveSnapshot {
  sources: MoveSource[];
  destinationId: string;
  destinationLimit: number;
  destinationOccupancy: number;
  members: MoveMember[];
  botsSkipped: number;
  takenAt: number;
}
export interface MoveInput {
  id: string;
  guildId: string;
  actorId: string;
  sources: MoveSource[];
  destinationId: string | null;
  snapshotAt: number | null;
  botsSkipped: number;
  members: MoveMember[];
}
export type MoveStatus = 'Running' | 'Completed' | 'Partially Completed' | 'Cancelled' | 'Failed' | 'Interrupted';
export type MemberStatus = 'pending' | 'processing' | 'moved' | 'skipped' | 'failed' | 'unknown';
export interface MoveResult extends MoveMember { status: MemberStatus; reason: string | null }
export interface MoveVerification {
  checkedAt: number;
  remaining: MoveMember[];
  unverified: string[];
}
export interface MoveJob extends Omit<MoveInput, 'members'> {
  verification: MoveVerification | null;
  status: MoveStatus;
  reason: string | null;
  createdAt: string;
  finishedAt: string | null;
  members: MoveResult[];
}
export interface VoiceMoveSettings { sourceIds: string[]; destinationId: string | null }
export interface VoiceMoveRepository {
  getSettings(guildId: string): Promise<VoiceMoveSettings>;
  setSources(guildId: string, sourceIds: string[]): Promise<void>;
  getDestination(guildId: string): Promise<string | null>;
  setDestination(guildId: string, destinationId: string): Promise<void>;
  create(input: MoveInput, cancelledReason?: string): Promise<void>;
  enqueue(id: string, members: MoveMember[]): Promise<void>;
  verify(id: string, verification: MoveVerification): Promise<void>;
  processing(id: string, userId: string): Promise<void>;
  outcome(id: string, userId: string, status: 'moved' | 'skipped' | 'failed' | 'unknown', reason: string | null): Promise<void>;
  finish(id: string, interruptedReason?: string): Promise<void>;
  get(id: string, guildId: string): Promise<MoveJob | undefined>;
  recover(guildId: string): Promise<void>;
  prune(guildId: string): Promise<void>;
}
export function moveCounts(job: MoveJob) {
  return {
    total: job.members.length,
    moved: job.members.filter(member => member.status === 'moved').length,
    skipped: job.members.filter(member => member.status === 'skipped').length,
    failed: job.members.filter(member => member.status === 'failed' || member.status === 'unknown').length,
    pending: job.members.filter(member => member.status === 'pending' || member.status === 'processing').length,
  };
}
