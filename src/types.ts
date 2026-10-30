export class UserError extends Error {}

export interface LeaderPresence { leaderIds: string[]; leadersKnown: boolean }

export interface RelayGroup { id: string; name: string; state: 'active' | 'paused'; legacy: boolean }
export interface RelayTeam {
  id: string; groupId: string; channelId: string;
  workerId: number;
}
export interface RelaySnapshot { groups: RelayGroup[]; teams: RelayTeam[]; session?: boolean }
export type RelayMutation =
  | { kind: 'group.create'; name: string }
  | { kind: 'group.state'; groupId: string; state: 'active' | 'paused'; expected?: string }
  | { kind: 'group.delete'; groupId: string; expected: string }
  | { kind: 'team.add'; groupId: string; channelId: string }
  | { kind: 'team.remove'; teamId: string; expected: string };

// Confirmations bind to the complete current target, including child teams.
export function targetVersion(snapshot: RelaySnapshot, kind: 'group' | 'team', id: string): string {
  return JSON.stringify(kind === 'group'
    ? [snapshot.groups.find(group => group.id === id), snapshot.teams.filter(team => team.groupId === id).sort((a, b) => a.id.localeCompare(b.id))]
    : snapshot.teams.find(team => team.id === id));
}
