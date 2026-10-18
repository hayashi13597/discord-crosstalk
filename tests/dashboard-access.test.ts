import { describe, expect, it } from "vitest";
import { PermissionFlagsBits, type GuildMember } from "discord.js";
import { capabilities } from "../src/dashboard-access.js";
const member = (roles: string[], permissions: bigint[]) =>
  ({
    roles: { cache: new Map(roles.map((id) => [id, {}])) },
    permissions: {
      has: (flag: bigint) =>
        permissions.includes(flag) ||
        permissions.includes(PermissionFlagsBits.Administrator),
    },
  }) as unknown as GuildMember;
describe("dashboard and slash-command shared capabilities", () => {
  const config = { adminRoleIds: ["legacy"] };
  it("denies ordinary users and limits viewers to reading", () => {
    expect(capabilities(member([], []), config, []).read).toBe(false);
    expect(
      capabilities(member(["viewer"], []), config, [
        { roleId: "viewer", level: "viewer", capabilities: [] },
      ]),
    ).toMatchObject({
      read: true,
      groups: false,
      teams: false,
      audit: false,
      settings: false,
      move: false,
    });
  });
  it("does not let Operator or legacy admin roles bypass Mass Move or manage Settings", () => {
    expect(
      capabilities(member(["op"], [PermissionFlagsBits.MoveMembers]), config, [
        { roleId: "op", level: "operator", capabilities: ["group.write"] },
      ]),
    ).toMatchObject({
      groups: true,
      teams: false,
      move: false,
      settings: false,
    });
    expect(
      capabilities(
        member(["legacy"], [PermissionFlagsBits.MoveMembers]),
        config,
        [],
      ),
    ).toMatchObject({
      groups: true,
      teams: true,
      move: false,
      settings: false,
    });
  });
  it("requires Move Members as well as Manage Guild, while preserving Administrator semantics", () => {
    expect(
      capabilities(member([], [PermissionFlagsBits.ManageGuild]), config, []),
    ).toMatchObject({ settings: true, move: false });
    expect(
      capabilities(member([], [PermissionFlagsBits.Administrator]), config, [])
        .move,
    ).toBe(true);
    expect(
      capabilities(
        member(
          [],
          [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.MoveMembers],
        ),
        config,
        [],
      ).move,
    ).toBe(true);
  });
});
