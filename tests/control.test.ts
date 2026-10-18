import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import {
  createControlHandler,
  readBody,
  snowflake,
  uuid,
  validSecret,
} from "../src/control.js";
const actor = "123456789012345678";
const guildId = "123456789012345679";
const secret = "s".repeat(64);
let server: Server | undefined;
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  server?.closeAllConnections();
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  server = undefined;
  stop = undefined;
});
async function harness(
  permissions: bigint[] = [PermissionFlagsBits.ManageGuild],
) {
  const member = {
    roles: { cache: new Map() },
    permissions: { has: (flag: bigint) => permissions.includes(flag) },
  };
  const guild = {
    id: guildId,
    name: "Test guild",
    available: true,
    iconURL: () => null,
    client: { isReady: () => true },
    roles: { fetch: vi.fn(), cache: new Map() },
    members: { fetch: vi.fn(async () => member) },
    channels: { cache: new Map() },
  };
  const deps = {
    config: {
      guildId,
      adminRoleIds: [],
      leaderRoleId: actor,
      bots: { 1: { token: "PRIVATE_BOT_TOKEN" } },
      workers: [],
    },
    pool: { query: vi.fn(async () => ({ rows: [] })) },
    runtime: { controlGuild: () => guild },
    relays: { snapshot: { groups: [], teams: [] } },
    moves: {},
    onError: vi.fn(),
  };
  const control = createControlHandler(deps as never, secret);
  stop = control.stop;
  server = createServer(control.handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${address.port}/internal/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${secret}`,
        "x-actor-id": actor,
        ...init.headers,
      },
    });
  return { deps, guild, request };
}
describe("private worker control boundary", () => {
  it("validates identifiers and bearer secrets", () => {
    expect(validSecret(`Bearer ${secret}`, secret)).toBe(true);
    expect(validSecret("Bearer short", secret)).toBe(false);
    expect(() => snowflake("../guild")).toThrow();
    expect(() => uuid(actor)).toThrow();
  });
  it("rejects invalid JSON and oversized bodies", async () => {
    const body = (data: string) => ({
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(data);
      },
    });
    await expect(readBody(body("[]") as never)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      readBody(body("x".repeat(131073)) as never),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("rejects wrong secret before touching Discord/database", async () => {
    const { request, deps, guild } = await harness();
    const response = await request("/snapshot", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(response.status).toBe(401);
    expect(guild.members.fetch).not.toHaveBeenCalled();
    expect(deps.pool.query).not.toHaveBeenCalled();
  });
  it("denies users who have not been granted access", async () => {
    const { request } = await harness([]);
    expect((await request("/snapshot")).status).toBe(403);
  });
  it("returns real metadata without any token and reuses short-lived read authorization", async () => {
    const { request, guild } = await harness();
    const response = await request("/snapshot");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("Test guild");
    expect(body).not.toContain("PRIVATE_BOT_TOKEN");
    await request("/access");
    expect(guild.members.fetch).toHaveBeenCalledTimes(1);
  });
  it("fails closed when gateway is offline", async () => {
    const { request, guild } = await harness();
    guild.available = false;
    expect((await request("/snapshot")).status).toBe(503);
  });
  it("prevents Mass Move privilege escalation and verifies fresh authorization for mutations", async () => {
    const { request, guild } = await harness();
    await request("/access");
    const response = await request("/moves/preview", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(guild.members.fetch).toHaveBeenCalledTimes(2);
  });
});
