export const TEAMS = [1, 2, 3] as const;
export type Team = (typeof TEAMS)[number];
export type Leaders = Record<Team, string | null>;
export const emptyLeaders = (): Leaders => ({ 1: null, 2: null, 3: null });

export function isTeam(value: number): value is Team {
  return TEAMS.includes(value as Team);
}

export class UserError extends Error {}
