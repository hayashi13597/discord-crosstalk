export const TEAMS = [1, 2, 3] as const;
export type Team = (typeof TEAMS)[number];
export type Leaders = Record<Team, string | null>;
export const emptyLeaders = (): Leaders => ({ 1: null, 2: null, 3: null });

export function isTeam(value: number): value is Team {
  return TEAMS.includes(value as Team);
}

export class UserError extends Error {}

export interface RelayGroup { id: string; name: string; state: 'active' | 'paused'; legacy: boolean }
export interface RelayTeam {
  id: string; groupId: string; channelId: string; leaderId: string | null;
  workerId: number; legacySlot: Team | null;
}
export interface RelaySnapshot { groups: RelayGroup[]; teams: RelayTeam[] }
export type RelayMutation =
  | { kind: 'group.create'; name: string }
  | { kind: 'group.state'; groupId: string; state: 'active' | 'paused' }
  | { kind: 'group.delete'; groupId: string; expected: string }
  | { kind: 'team.add'; groupId: string; channelId: string }
  | { kind: 'team.remove'; teamId: string; expected: string }
  | { kind: 'leader.change'; teamId: string; userId: string | null; expected?: string };

// Confirmations bind to the complete current target, including child teams.
export function targetVersion(snapshot: RelaySnapshot, kind: 'group' | 'team', id: string): string {
  return JSON.stringify(kind === 'group'
    ? [snapshot.groups.find(group => group.id === id), snapshot.teams.filter(team => team.groupId === id).sort((a, b) => a.id.localeCompare(b.id))]
    : snapshot.teams.find(team => team.id === id));
}
