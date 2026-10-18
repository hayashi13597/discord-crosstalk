import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import pg from "pg";
import { PermissionFlagsBits } from "discord.js";
import { migrate } from "../src/database.js";
import { loadConfig } from "../src/config.js";
import { PostgresRelays } from "../src/relay-repository.js";
import { RelayService } from "../src/relays.js";
import { PostgresVoiceMoves } from "../src/voice-move-repository.js";
import { VoiceMoveService } from "../src/voice-moves.js";
import { createControlHandler } from "../src/control.js";
import { DiscordMoveGateway } from "../src/voice-move-discord.js";
import { targetVersion } from "../src/types.js";
const actor = "123456789012345678";
const config = loadConfig({
  GUILD_ID: actor,
  LEADER_ROLE_ID: "123456789012345680",
  BOT_TOKEN_1: "a",
  BOT_TOKEN_2: "b",
  BOT_TOKEN_3: "c",
  BOT_TOKEN_4: "d",
  BOT_TOKEN_5: "e",
  VOICE_CHANNEL_ID_1: "123456789012345671",
  VOICE_CHANNEL_ID_2: "123456789012345672",
  VOICE_CHANNEL_ID_3: "123456789012345673",
  DATABASE_URL: "postgresql://localhost/test",
});
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "dashboard on real PostgreSQL",
  () => {
    const schema = `test_dashboard_${randomBytes(6).toString("hex")}`;
    let pool: pg.Pool;
    let admin: pg.Pool;
    let relays: RelayService;
    let repository: PostgresRelays;
    let moveRepository: PostgresVoiceMoves;
    let moves: VoiceMoveService;
    let server: Server;
    let stop: () => Promise<void>;
    let request: (
      path: string,
      body?: unknown,
      id?: string,
    ) => Promise<Response>;
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path=${schema}`,
      });
      await migrate(pool);
      await migrate(pool);
    });
    beforeEach(async () => {
      await pool.query(
        "TRUNCATE relay_guilds,relay_audit,dashboard_operations,dashboard_move_previews,dashboard_audit,dashboard_permissions,voice_move_jobs CASCADE",
      );
      repository = new PostgresRelays(pool, config);
      relays = new RelayService(
        repository,
        () => {},
        () => {},
      );
      await relays.initialize();
      moveRepository = new PostgresVoiceMoves(pool);
      moves = new VoiceMoveService(moveRepository, () => {});
      const member = {
        permissions: {
          has: (flag: bigint) =>
            [
              PermissionFlagsBits.ManageGuild,
              PermissionFlagsBits.MoveMembers,
            ].includes(flag),
        },
        roles: { cache: new Map() },
      };
      const guild = {
        id: actor,
        available: true,
        name: "Test",
        iconURL: () => null,
        client: { isReady: () => true },
        members: { fetch: async () => member },
        roles: { fetch: async () => {}, cache: new Map() },
        channels: { cache: new Map() },
      };
      const control = createControlHandler(
        {
          config,
          pool,
          relays,
          moves,
          runtime: {
            controlGuild: () => guild,
            workerStatus: () => undefined,
            controlWorkerIdentity: () => undefined,
          } as never,
          onError: () => {},
        },
        "s".repeat(64),
      );
      stop = control.stop;
      server = createServer(control.handler);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;
      request = (path, body, id) =>
        fetch(`http://127.0.0.1:${port}/internal/v1${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${"s".repeat(64)}`,
            "x-actor-id": actor,
            ...(id ? { "idempotency-key": id } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await stop?.();
      server?.closeAllConnections();
      await new Promise<void>((resolve) =>
        server ? server.close(() => resolve()) : resolve(),
      );
      await moves?.stop();
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });
    it("deduplicates concurrent mutations and rejects key reuse with different payloads", async () => {
      const id = randomUUID();
      const responses = await Promise.all([
        request("/groups", { name: "Bravo" }, id),
        request("/groups", { name: "Bravo" }, id),
      ]);
      expect(responses.some((r) => r.status === 200)).toBe(true);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM relay_groups WHERE name='Bravo'",
          )
        ).rows[0].n,
      ).toBe(1);
      expect((await request("/groups", { name: "Bravo" }, id)).status).toBe(
        200,
      );
      expect((await request("/groups", { name: "Charlie" }, id)).status).toBe(
        409,
      );
      const operation = await (await request(`/operations/${id}`)).json();
      expect(operation.status).toBe("Applied");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM relay_audit WHERE action='group.create'",
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it("renames groups, rejects stale edits, and protects Group A", async () => {
      const group = relays.snapshot.groups[0]!;
      const expected = targetVersion(relays.snapshot, "group", group.id);
      expect(
        (
          await request(
            `/groups/${group.id}/rename`,
            { name: "Alpha", expected },
            randomUUID(),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await request(
            `/groups/${group.id}/rename`,
            { name: "Old", expected },
            randomUUID(),
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await request(
            `/groups/${group.id}/delete`,
            { expected: targetVersion(relays.snapshot, "group", group.id) },
            randomUUID(),
          )
        ).status,
      ).toBe(409);
      expect(relays.snapshot.groups[0]!.name).toBe("Alpha");
    });
    it("supports team metadata and requires paused groups for structural updates", async () => {
      await relays.mutate({ kind: "group.create", name: "Bravo" }, actor);
      const group = relays.snapshot.groups.find((g) => !g.legacy)!;
      await relays.mutate(
        { kind: "team.add", groupId: group.id, channelId: "b1" },
        actor,
      );
      let team = relays.snapshot.teams.find((t) => t.groupId === group.id)!;
      await relays.mutate(
        {
          kind: "team.update",
          teamId: team.id,
          groupId: group.id,
          channelId: "b2",
          workerId: 5,
          name: "Blue",
          expected: targetVersion(relays.snapshot, "team", team.id),
        },
        actor,
      );
      team = relays.snapshot.teams.find((t) => t.id === team.id)!;
      expect(team).toMatchObject({
        name: "Blue",
        channelId: "b2",
        workerId: 5,
      });
      await relays.mutate(
        { kind: "group.state", groupId: group.id, state: "active" },
        actor,
      );
      await expect(
        relays.mutate(
          {
            kind: "team.update",
            teamId: team.id,
            groupId: group.id,
            channelId: "b3",
            workerId: 5,
            name: "Blue",
            expected: targetVersion(relays.snapshot, "team", team.id),
          },
          actor,
        ),
      ).rejects.toThrow("Pause");
      expect(
        relays.snapshot.teams
          .filter((t) => t.legacySlot)
          .map((t) => t.channelId),
      ).toEqual([
        config.bots[1].channelId,
        config.bots[2].channelId,
        config.bots[3].channelId,
      ]);
    });
    it("persists settings and filters audit entries without exposing other guilds", async () => {
      expect(
        (
          await request(
            "/settings",
            { rules: [], expected: "[]" },
            randomUUID(),
          )
        ).status,
      ).toBe(200);
      await pool.query(
        "INSERT INTO dashboard_audit(guild_id,actor_id,action,result) VALUES('other','someone','private','Applied')",
      );
      const audit = await (await request("/audit?action=settings")).json();
      expect(audit.items).toHaveLength(1);
      expect(audit.items[0].actor_id).toBe(actor);
    });
    it("rejects stale Settings instead of overwriting another administrator", async () => {
      await pool.query(
        "INSERT INTO dashboard_permissions(guild_id,rules) VALUES($1,$2)",
        [
          actor,
          JSON.stringify([
            { roleId: "role", level: "viewer", capabilities: [] },
          ]),
        ],
      );
      expect(
        (
          await request(
            "/settings",
            { rules: [], expected: "[]" },
            randomUUID(),
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await pool.query(
            "SELECT rules FROM dashboard_permissions WHERE guild_id=$1",
            [actor],
          )
        ).rows[0].rules,
      ).toHaveLength(1);
    });
    it("does not execute expired previews", async () => {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO dashboard_move_previews(id,guild_id,actor_id,snapshot,expires_at) VALUES($1,$2,$2,'{}',now()-interval '1 second')",
        [id, actor],
      );
      expect((await request("/moves/confirm", { previewId: id })).status).toBe(
        409,
      );
      expect(await moveRepository.get(id, actor)).toBeUndefined();
    });
    it("commits a job before acknowledgement and confirms the same preview only once", async () => {
      vi.spyOn(DiscordMoveGateway.prototype, "validate").mockResolvedValue();
      vi.spyOn(DiscordMoveGateway.prototype, "ready").mockReturnValue(true);
      const move = vi
        .spyOn(DiscordMoveGateway.prototype, "move")
        .mockResolvedValue({ status: "moved", reason: null });
      const id = randomUUID(),
        takenAt = Date.now();
      const snapshot = {
        takenAt,
        members: [{ userId: "human", sourceId: "source" }],
        sources: [{ id: "source", humans: 1, bots: 0 }],
        destinationId: "dest",
        botsSkipped: 0,
      };
      await pool.query(
        "INSERT INTO dashboard_move_previews(id,guild_id,actor_id,snapshot,expires_at) VALUES($1,$2,$2,$3,$4)",
        [id, actor, snapshot, new Date(takenAt + 60000)],
      );
      const result = await request("/moves/confirm", { previewId: id });
      expect(result.status).toBe(202);
      expect(await moveRepository.get(id, actor)).toBeDefined();
      expect((await request("/moves/confirm", { previewId: id })).status).toBe(
        200,
      );
      await moves.stop();
      expect(move).toHaveBeenCalledTimes(1);
      expect(
        (await pool.query("SELECT count(*)::int n FROM voice_move_jobs"))
          .rows[0].n,
      ).toBe(1);
    });
    it("cancels only unprocessed members and preserves saved outcomes", async () => {
      const id = randomUUID();
      await moveRepository.create({
        id,
        actorId: actor,
        guildId: actor,
        sources: [],
        destinationId: "dest",
        snapshotAt: Date.now(),
        botsSkipped: 0,
        members: [
          { userId: "a", sourceId: "s" },
          { userId: "b", sourceId: "s" },
        ],
      });
      await moveRepository.processing(id, "a");
      await moveRepository.outcome(id, "a", "moved", null);
      await request(`/moves/${id}/cancel`, {});
      expect(await moveRepository.cancellationRequested(id)).toBe(true);
      await moveRepository.cancel(id);
      const job = await moveRepository.get(id, actor);
      expect(job?.status).toBe("Cancelled");
      expect(job?.members.map((m) => m.status)).toEqual(["moved", "skipped"]);
    });
  },
);
