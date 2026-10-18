export interface Access {
  admin: boolean;
  read: boolean;
  groups: boolean;
  teams: boolean;
  audit: boolean;
  move: boolean;
  settings: boolean;
}
export interface Session {
  user: { id: string; username: string; global_name?: string | null };
  csrf: string;
  access: Access;
  guild: { id: string; name: string; icon: string | null };
}
export interface Group {
  id: string;
  name: string;
  state: "active" | "paused";
  legacy: boolean;
  actual: string;
  version: string;
}
export interface Team {
  id: string;
  name?: string;
  groupId: string;
  channelId: string;
  workerId: number;
  legacySlot: number | null;
  version: string;
}
export interface Bot {
  id: number;
  userId?: string;
  name: string;
  teamId: string | null;
  reserved: boolean;
  gateway?: boolean;
  voice?: string;
  channelId?: string | null;
  leaderIds?: string[];
  leadersKnown?: boolean;
  receiving?: boolean;
  lastError?: string | null;
}
export interface Member {
  id: string;
  name: string;
  bot: boolean;
  leader: boolean;
}
export interface Channel {
  id: string;
  name: string;
  limit: number;
  members: Member[];
}
export interface Snapshot {
  updatedAt: string;
  guild: Session["guild"];
  leaderRoleId: string;
  groups: Group[];
  teams: Team[];
  bots: Bot[];
  channels: Channel[];
}
export interface Preview {
  id: string;
  expiresAt: number;
  members: { userId: string; sourceId: string }[];
  sources: { id: string; humans: number; bots: number }[];
  destinationId: string;
  destinationLimit: number;
  destinationOccupancy: number;
  botsSkipped: number;
  leaders: string[];
}
export interface Job {
  id: string;
  status: string;
  reason: string | null;
  actorId: string;
  createdAt: string;
  finishedAt: string | null;
  members: {
    userId: string;
    sourceId: string;
    status: string;
    reason: string | null;
  }[];
}
export interface Audit {
  id: string;
  actor_id: string;
  action: string;
  changed_at: string;
  result: string;
  details: Record<string, unknown>;
}
export interface Rule {
  roleId: string;
  level: "viewer" | "operator";
  capabilities: string[];
}
