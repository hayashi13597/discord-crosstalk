import { PermissionFlagsBits, type GuildMember } from "discord.js";
import type pg from "pg";
import type { Config } from "./config.js";
export type Capability = "read" | "group.write" | "team.write" | "audit.read";
export interface RoleRule {
  roleId: string;
  level: "viewer" | "operator";
  capabilities: ("group.write" | "team.write" | "audit.read")[];
}
export interface Access {
  admin: boolean;
  read: boolean;
  groups: boolean;
  teams: boolean;
  audit: boolean;
  move: boolean;
  settings: boolean;
}
export function capabilities(
  member: GuildMember,
  config: Pick<Config, "adminRoleIds">,
  rules: RoleRule[],
): Access {
  const admin = member.permissions.has(PermissionFlagsBits.ManageGuild);
  const legacy = config.adminRoleIds.some((id) => member.roles.cache.has(id));
  const matching = rules.filter((rule) => member.roles.cache.has(rule.roleId));
  const allowed = (cap: string) =>
    admin ||
    legacy ||
    matching.some(
      (rule) =>
        rule.level === "operator" && rule.capabilities.includes(cap as never),
    );
  return {
    admin,
    read: admin || legacy || matching.length > 0,
    groups: allowed("group.write"),
    teams: allowed("team.write"),
    audit:
      admin ||
      legacy ||
      matching.some((rule) => rule.capabilities.includes("audit.read")),
    settings: admin,
    move: admin && member.permissions.has(PermissionFlagsBits.MoveMembers),
  };
}
export async function permissionRules(
  pool: pg.Pool,
  guildId: string,
): Promise<RoleRule[]> {
  return (
    (
      await pool.query(
        "SELECT rules FROM dashboard_permissions WHERE guild_id=$1",
        [guildId],
      )
    ).rows[0]?.rules ?? []
  );
}
