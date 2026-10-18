import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type VoiceChannel,
} from "discord.js";
import type pg from "pg";
import type { Config } from "./config.js";
import type { RelayRuntime } from "./runtime.js";
import type { RelayService } from "./relays.js";
import { CommitUncertainError } from "./database.js";
import { UserError, targetVersion, type RelayMutation } from "./types.js";
import {
  capabilities,
  permissionRules,
  type RoleRule,
} from "./dashboard-access.js";
import { createMoveRest, DiscordMoveGateway } from "./voice-move-discord.js";
import type { VoiceMoveService } from "./voice-moves.js";
import type { MoveInput, MoveSnapshot } from "./voice-move-types.js";

export class ControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const snowflake = (value: unknown): string => {
  if (typeof value !== "string" || !/^\d{17,20}$/.test(value))
    throw new ControlError(400, "INVALID_ID", "Discord ID không hợp lệ.");
  return value;
};
export const uuid = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
  )
    throw new ControlError(400, "INVALID_ID", "ID không hợp lệ.");
  return value;
};
const text = (value: unknown, max = 80) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > max ||
    /[\x00-\x1f]/.test(value)
  )
    throw new ControlError(400, "INVALID_INPUT", "Giá trị không hợp lệ.");
  return value.trim();
};
const requireValue = (
  ok: unknown,
  code = "FORBIDDEN",
  message = "Bạn không có quyền thực hiện thao tác này.",
) => {
  if (!ok)
    throw new ControlError(code === "FORBIDDEN" ? 403 : 409, code, message);
};
export function validSecret(received: string, secret: string) {
  const a = Buffer.from(received);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024)
      throw new ControlError(413, "BODY_TOO_LARGE", "Request quá lớn.");
    chunks.push(chunk);
  }
  try {
    const result: unknown = JSON.parse(
      Buffer.concat(chunks).toString() || "{}",
    );
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error();
    return result as Record<string, unknown>;
  } catch {
    throw new ControlError(400, "INVALID_JSON", "JSON không hợp lệ.");
  }
}
interface Dependencies {
  config: Config;
  pool: pg.Pool;
  runtime: RelayRuntime;
  relays: RelayService;
  moves: VoiceMoveService;
  onError: (error: unknown) => void;
}
export function createControlHandler(
  { config, pool, runtime, relays, moves, onError }: Dependencies,
  secret: string,
) {
  const transport = createMoveRest(config.bots[1].token);
  const limits = new Map<string, { count: number; until: number }>();
  const inFlight = new Set<string>();
  const readAccess = new Map<
    string,
    { until: number; access: ReturnType<typeof capabilities> }
  >();
  let cache: { until: number; value: unknown } | undefined;
  let closing = false;
  const pending = new Set<Promise<void>>();
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(data));
  };
  const audit = async (
    actor: string,
    action: string,
    target: string | null,
    details: unknown = {},
    result = "Applied",
  ) => {
    await pool.query(
      "INSERT INTO dashboard_audit(guild_id,actor_id,action,target_id,result,details) VALUES($1,$2,$3,$4,$5,$6)",
      [config.guildId, actor, action, target, result, JSON.stringify(details)],
    );
  };
  const guildReady = (): Guild => {
    const guild = runtime.controlGuild();
    if (!guild?.available || !guild.client.isReady())
      throw new ControlError(
        503,
        "WORKER_OFFLINE",
        "Discord gateway chưa sẵn sàng.",
      );
    return guild;
  };
  const snapshot = async (guild: Guild) => {
    if (cache && cache.until > Date.now()) return cache.value;
    const state = relays.snapshot;
    const workers = config.workers.map((worker) => {
      const bot = runtime.workerStatus(worker.id);
      const identity = runtime.controlWorkerIdentity(worker.id);
      return {
        id: worker.id,
        ...identity,
        ...bot,
        teamId: state.teams.find((t) => t.workerId === worker.id)?.id ?? null,
        reserved: worker.id <= 3,
        name: identity?.name ?? `Bot ${worker.id}`,
      };
    });
    const channels = [...guild.channels.cache.values()]
      .filter(
        (c): c is VoiceChannel =>
          c.type === ChannelType.GuildVoice &&
          (!guild.members.me ||
            c
              .permissionsFor(guild.members.me)
              ?.has(PermissionFlagsBits.ViewChannel)),
      )
      .map((c) => ({
        id: c.id,
        name: c.name,
        limit: c.userLimit,
        members: [...c.members.values()].map((m) => ({
          id: m.id,
          name: m.displayName,
          bot: m.user.bot,
          leader: !m.user.bot && m.roles.cache.has(config.leaderRoleId),
        })),
      }));
    const groups = state.groups.map((g) => {
      const bots = state.teams
        .filter((t) => t.groupId === g.id)
        .map((t) => runtime.workerStatus(t.workerId));
      return {
        ...g,
        version: targetVersion(state, "group", g.id),
        actual:
          g.state === "paused"
            ? "Paused"
            : !bots.length
              ? "Offline"
              : runtime.groupError(g.id)
                ? "Degraded"
                : bots.every((b) => b?.gateway && b.voice === "ready")
                  ? "Active"
                  : bots.some((b) => b?.gateway)
                    ? "Degraded"
                    : "Offline",
      };
    });
    const value = {
      updatedAt: new Date().toISOString(),
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL() },
      leaderRoleId: config.leaderRoleId,
      groups,
      teams: state.teams.map((t) => ({
        ...t,
        version: targetVersion(state, "team", t.id),
      })),
      bots: workers,
      channels,
    };
    cache = { until: Date.now() + 1800, value };
    return value;
  };
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!validSecret(req.headers.authorization ?? "", secret))
      throw new ControlError(401, "UNAUTHORIZED", "Unauthorized");
    if (closing)
      throw new ControlError(503, "WORKER_STOPPING", "Worker đang dừng.");
    const actorId = snowflake(req.headers["x-actor-id"]);
    const now = Date.now();
    for (const [id, limit] of limits) if (limit.until <= now) limits.delete(id);
    if (!limits.has(actorId) && limits.size >= 2000)
      throw new ControlError(429, "RATE_LIMIT", "Quá nhiều phiên.");
    const limit = limits.get(actorId) ?? { count: 0, until: now + 60000 };
    limits.set(actorId, limit);
    if (++limit.count > 180)
      throw new ControlError(429, "RATE_LIMIT", "Vui lòng thử lại sau.");
    const url = new URL(req.url ?? "/", "http://worker");
    const path = url.pathname.replace(/^\/internal\/v1/, "");
    if (!url.pathname.startsWith("/internal/v1/"))
      throw new ControlError(404, "NOT_FOUND", "Không tìm thấy API.");
    const guild = guildReady();
    // Reads briefly cache authorization; every mutation fetches current Discord roles/membership.
    for (const [id, entry] of readAccess)
      if (entry.until < now) readAccess.delete(id);
    const cached = req.method === "GET" ? readAccess.get(actorId) : undefined;
    const access =
      cached?.access ??
      (await (async () => {
        await guild.roles.fetch();
        const member = await guild.members
          .fetch({ user: actorId, force: true })
          .catch(() => {
            throw new ControlError(
              403,
              "FORBIDDEN",
              "Bạn không còn trong server.",
            );
          });
        const resolved = capabilities(
          member,
          config,
          await permissionRules(pool, config.guildId),
        );
        readAccess.set(actorId, { until: now + 15000, access: resolved });
        return resolved;
      })());
    requireValue(access.read);
    if (req.method === "GET") {
      if (path === "/access")
        return json(res, 200, {
          access,
          guild: { id: guild.id, name: guild.name, icon: guild.iconURL() },
        });
      if (path === "/snapshot") return json(res, 200, await snapshot(guild));
      if (path === "/settings") {
        requireValue(access.settings);
        return json(res, 200, {
          rules: await permissionRules(pool, config.guildId),
          roles: [...guild.roles.cache.values()]
            .filter((r) => r.id !== guild.id && !r.managed)
            .map((r) => ({ id: r.id, name: r.name })),
        });
      }
      if (path.startsWith("/operations/")) {
        const id = uuid(path.split("/")[2]);
        const row = (
          await pool.query(
            "SELECT id,status,result FROM dashboard_operations WHERE id=$1 AND guild_id=$2 AND actor_id=$3",
            [id, guild.id, actorId],
          )
        ).rows[0];
        if (!row)
          throw new ControlError(404, "NOT_FOUND", "Không tìm thấy thao tác.");
        return json(res, 200, row);
      }
      if (path === "/audit") {
        requireValue(access.audit);
        const page = Math.max(
          0,
          Math.min(100000, Number(url.searchParams.get("page")) || 0),
        );
        const actor = url.searchParams.get("actor") || null;
        const action = url.searchParams.get("action") || null;
        const group = url.searchParams.get("group") || null;
        const since = url.searchParams.get("since") || null;
        const until = url.searchParams.get("until") || null;
        if (
          (since && !Number.isFinite(Date.parse(since))) ||
          (until && !Number.isFinite(Date.parse(until)))
        )
          throw new ControlError(
            400,
            "INVALID_INPUT",
            "Thời gian không hợp lệ.",
          );
        const rows = await pool.query(
          `SELECT * FROM (
          SELECT id::text,guild_id,actor_id,action,details,changed_at, 'Applied'::text AS result,
            COALESCE(details->>'groupId',details->'before'->>'groupId') AS group_id FROM relay_audit
          UNION ALL SELECT id::text,guild_id,actor_id,action,details,changed_at,result,group_id FROM dashboard_audit
          UNION ALL SELECT id::text,guild_id,actor_id,'voice.move',jsonb_build_object('jobId',id,'sources',sources,'destinationId',destination_id,'reason',reason,'counts',
            (SELECT jsonb_build_object('moved',count(*) FILTER(WHERE status='moved'),'skipped',count(*) FILTER(WHERE status='skipped'),
              'failed',count(*) FILTER(WHERE status IN ('failed','unknown'))) FROM voice_move_members WHERE job_id=voice_move_jobs.id)),created_at,status,NULL FROM voice_move_jobs
        ) a WHERE guild_id=$1 AND ($2::text IS NULL OR actor_id=$2) AND ($3::text IS NULL OR action ILIKE '%'||$3||'%')
          AND ($4::text IS NULL OR group_id=$4) AND ($5::timestamptz IS NULL OR changed_at >= $5::timestamptz)
          AND ($6::timestamptz IS NULL OR changed_at <= $6::timestamptz)
          ORDER BY changed_at DESC,id DESC LIMIT 51 OFFSET $7`,
          [guild.id, actor, action, group, since, until, page * 50],
        );
        return json(res, 200, {
          items: rows.rows.slice(0, 50),
          hasMore: rows.rows.length > 50,
        });
      }
      if (path === "/moves") {
        requireValue(access.move);
        const page = Math.max(
          0,
          Math.min(100000, Number(url.searchParams.get("page")) || 0),
        );
        return json(res, 200, {
          items: (
            await pool.query(
              "SELECT id,status,actor_id,created_at,finished_at,reason FROM voice_move_jobs WHERE guild_id=$1 ORDER BY created_at DESC LIMIT 51 OFFSET $2",
              [guild.id, page * 50],
            )
          ).rows,
        });
      }
      if (/^\/moves\/[^/]+$/.test(path)) {
        requireValue(access.move);
        const job = await moves.repository.get(
          uuid(path.split("/")[2]),
          guild.id,
        );
        if (!job)
          throw new ControlError(404, "NOT_FOUND", "Không tìm thấy job.");
        return json(res, 200, job);
      }
      throw new ControlError(404, "NOT_FOUND", "Không tìm thấy API.");
    }
    if (req.method !== "POST")
      throw new ControlError(405, "METHOD_NOT_ALLOWED", "Method không hỗ trợ.");
    const body = await readBody(req);
    if (path === "/moves/preview") {
      requireValue(access.move);
      if (
        !Array.isArray(body.sources) ||
        !body.sources.length ||
        body.sources.length > guild.channels.cache.size
      )
        throw new ControlError(400, "INVALID_INPUT", "Hãy chọn nguồn hợp lệ.");
      const sources = body.sources.map(snowflake);
      const destination = snowflake(body.destinationId);
      const preview = await new DiscordMoveGateway(guild, transport).snapshot(
        actorId,
        sources,
        destination,
      );
      const id = uuid(body.id);
      await pool.query(
        "DELETE FROM dashboard_move_previews WHERE expires_at < now() - interval '1 day'",
      );
      await pool.query(
        "INSERT INTO dashboard_move_previews(id,guild_id,actor_id,snapshot,expires_at) VALUES($1,$2,$3,$4,$5)",
        [
          id,
          guild.id,
          actorId,
          JSON.stringify(preview),
          new Date(preview.takenAt + 60000),
        ],
      );
      const leaders = preview.members
        .filter((m) =>
          guild.members.cache
            .get(m.userId)
            ?.roles.cache.has(config.leaderRoleId),
        )
        .map((m) => m.userId);
      return json(res, 200, {
        id,
        ...preview,
        leaders,
        expiresAt: preview.takenAt + 60000,
      });
    }
    if (path === "/moves/confirm") {
      requireValue(access.move);
      const id = uuid(body.previewId);
      const existing = await moves.repository.get(id, guild.id);
      if (existing) {
        requireValue(existing.actorId === actorId);
        return json(res, 200, existing);
      }
      if (inFlight.has(id)) return json(res, 202, { id, status: "Pending" });
      inFlight.add(id);
      try {
        const row = (
          await pool.query(
            "SELECT snapshot,expires_at FROM dashboard_move_previews WHERE id=$1 AND guild_id=$2 AND actor_id=$3 AND consumed_at IS NULL",
            [id, guild.id, actorId],
          )
        ).rows[0];
        requireValue(
          row && row.expires_at.getTime() > Date.now(),
          "PREVIEW_EXPIRED",
          "Preview hết hạn. Hãy xem trước lại.",
        );
        const snap = row.snapshot as MoveSnapshot;
        const input: MoveInput = {
          id,
          guildId: guild.id,
          actorId,
          sources: snap.sources,
          destinationId: snap.destinationId,
          snapshotAt: snap.takenAt,
          botsSkipped: snap.botsSkipped,
          members: snap.members,
        };
        const gateway = new DiscordMoveGateway(guild, transport);
        // run() synchronously reserves the SAME guild slot used by slash commands.
        let resolveCreated!: () => void;
        let rejectCreated!: (error: unknown) => void;
        const created = new Promise<void>((resolve, reject) => {
          resolveCreated = resolve;
          rejectCreated = reject;
        });
        const running = moves.run(
          input,
          gateway,
          async () => {
            resolveCreated();
          },
          snap.takenAt + 60000,
        );
        void running.then(resolveCreated, rejectCreated);
        void running.catch(onError).finally(() => inFlight.delete(id));
        await created; // First progress follows the committed job insert.
        await pool.query(
          "UPDATE dashboard_move_previews SET consumed_at=now() WHERE id=$1",
          [id],
        );
        return json(res, 202, { id, status: "Running" });
      } catch (error) {
        inFlight.delete(id);
        throw error;
      }
    }
    if (/^\/moves\/[^/]+\/cancel$/.test(path)) {
      requireValue(access.move);
      const id = uuid(path.split("/")[2]);
      const changed = await pool.query(
        "UPDATE voice_move_jobs SET cancel_requested=true WHERE id=$1 AND guild_id=$2 AND status='Running' RETURNING id",
        [id, guild.id],
      );
      if (!changed.rowCount) {
        const job = await moves.repository.get(id, guild.id);
        if (!job)
          throw new ControlError(404, "NOT_FOUND", "Không tìm thấy job.");
        return json(res, 200, { id, status: job.status });
      }
      await audit(actorId, "voice.cancel", id);
      return json(res, 200, { id, status: "Pending" });
    }

    // All configuration mutations are recorded before attempting side effects.
    const operationId = uuid(req.headers["idempotency-key"]);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ path, body }))
      .digest("hex");
    const previous = await pool.query(
      "SELECT * FROM dashboard_operations WHERE id=$1",
      [operationId],
    );
    if (previous.rows[0]) {
      const row = previous.rows[0];
      requireValue(
        row.actor_id === actorId &&
          row.guild_id === guild.id &&
          row.fingerprint === fingerprint,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key đã dùng cho thao tác khác.",
      );
      return json(res, row.status === "Applied" ? 200 : 409, {
        id: operationId,
        status: row.status,
        result: row.result,
      });
    }
    if (path === "/settings") requireValue(access.settings);
    else if (path.startsWith("/groups")) requireValue(access.groups);
    else if (path.startsWith("/teams")) requireValue(access.teams);
    else throw new ControlError(404, "NOT_FOUND", "Không tìm thấy API.");
    const inserted = await pool.query(
      "INSERT INTO dashboard_operations(id,guild_id,actor_id,fingerprint,status) VALUES($1,$2,$3,$4,'Pending') ON CONFLICT DO NOTHING RETURNING id",
      [operationId, guild.id, actorId, fingerprint],
    );
    if (!inserted.rowCount)
      return json(res, 409, { id: operationId, status: "Pending" });
    try {
      if (path === "/settings") {
        if (!Array.isArray(body.rules) || body.rules.length > 100)
          throw new ControlError(
            400,
            "INVALID_INPUT",
            "Danh sách role không hợp lệ.",
          );
        const rules: RoleRule[] = body.rules.map((r: unknown) => {
          if (!r || typeof r !== "object")
            throw new ControlError(400, "INVALID_INPUT", "Role không hợp lệ.");
          const rule = r as RoleRule;
          snowflake(rule.roleId);
          requireValue(
            guild.roles.cache.has(rule.roleId) && rule.roleId !== guild.id,
            "INVALID_ROLE",
            "Role không tồn tại.",
          );
          if (
            !["operator", "viewer"].includes(rule.level) ||
            !Array.isArray(rule.capabilities) ||
            rule.capabilities.some(
              (c) => !["group.write", "team.write", "audit.read"].includes(c),
            ) ||
            (rule.level === "viewer" &&
              rule.capabilities.some((c) => c !== "audit.read"))
          )
            throw new ControlError(400, "INVALID_INPUT", "Quyền không hợp lệ.");
          return {
            roleId: rule.roleId,
            level: rule.level,
            capabilities: [...new Set(rule.capabilities)],
          };
        });
        if (new Set(rules.map((r) => r.roleId)).size !== rules.length)
          throw new ControlError(400, "INVALID_INPUT", "Role bị trùng.");
        const client = await pool.connect();
        let committing = false;
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [`crosstalk:permissions:${guild.id}`],
          );
          const before = await client.query(
            "SELECT rules FROM dashboard_permissions WHERE guild_id=$1 FOR UPDATE",
            [guild.id],
          );
          requireValue(
            body.expected === JSON.stringify(before.rows[0]?.rules ?? []),
            "CONFIG_CHANGED",
            "Phân quyền đã thay đổi. Hãy tải lại trang trước khi lưu.",
          );
          await client.query(
            "INSERT INTO dashboard_permissions(guild_id,rules) VALUES($1,$2) ON CONFLICT(guild_id) DO UPDATE SET rules=excluded.rules,updated_at=now()",
            [guild.id, JSON.stringify(rules)],
          );
          await client.query(
            "INSERT INTO dashboard_audit(guild_id,actor_id,action,result,details) VALUES($1,$2,'settings.update','Applied',$3)",
            [
              guild.id,
              actorId,
              JSON.stringify({
                before: before.rows[0]?.rules ?? [],
                after: rules,
              }),
            ],
          );
          committing = true;
          await client.query("COMMIT");
          committing = false;
          readAccess.clear();
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          if (committing) throw new CommitUncertainError(error);
          throw error;
        } finally {
          client.release();
        }
      } else {
        const parts = path.split("/");
        const expected = () => text(body.expected, 100000);
        let action: RelayMutation;
        if (path === "/groups")
          action = { kind: "group.create", name: text(body.name) };
        else if (parts[1] === "groups") {
          const groupId = uuid(parts[2]);
          if (parts[3] === "rename")
            action = {
              kind: "group.rename",
              groupId,
              name: text(body.name),
              expected: expected(),
            };
          else if (parts[3] === "delete")
            action = { kind: "group.delete", groupId, expected: expected() };
          else if (
            parts[3] === "state" &&
            ["active", "paused"].includes(String(body.state))
          )
            action = {
              kind: "group.state",
              groupId,
              state: body.state as "active" | "paused",
              expected: expected(),
            };
          else
            throw new ControlError(
              400,
              "INVALID_INPUT",
              "Thao tác không hợp lệ.",
            );
        } else if (path === "/teams") {
          action = {
            kind: "team.add",
            groupId: uuid(body.groupId),
            channelId: snowflake(body.channelId),
          };
          if (body.workerId !== undefined) {
            if (
              !Number.isSafeInteger(body.workerId) ||
              Number(body.workerId) < 4
            )
              throw new ControlError(
                400,
                "INVALID_INPUT",
                "Worker không hợp lệ.",
              );
            action.workerId = Number(body.workerId);
          }
        } else {
          const teamId = uuid(parts[2]);
          if (parts[3] === "delete")
            action = { kind: "team.remove", teamId, expected: expected() };
          else if (parts[3] === "update") {
            if (!Number.isSafeInteger(body.workerId))
              throw new ControlError(
                400,
                "INVALID_INPUT",
                "Worker không hợp lệ.",
              );
            action = {
              kind: "team.update",
              teamId,
              name: body.name ? text(body.name) : null,
              groupId: uuid(body.groupId),
              channelId: snowflake(body.channelId),
              workerId: Number(body.workerId),
              expected: expected(),
            };
          } else
            throw new ControlError(
              400,
              "INVALID_INPUT",
              "Thao tác không hợp lệ.",
            );
        }
        const currentTeam =
          "teamId" in action
            ? relays.snapshot.teams.find((team) => team.id === action.teamId)
            : undefined;
        const needsChannelValidation =
          action.kind === "team.add" ||
          (action.kind === "team.update" &&
            (!currentTeam ||
              currentTeam.channelId !== action.channelId ||
              currentTeam.groupId !== action.groupId ||
              currentTeam.workerId !== action.workerId));
        if ("channelId" in action && needsChannelValidation) {
          const channel = await guild.channels.fetch(action.channelId, {
            force: true,
          });
          requireValue(
            channel?.type === ChannelType.GuildVoice,
            "INVALID_CHANNEL",
            "Chỉ hỗ trợ voice channel thường.",
          );
          const workerId =
            action.kind === "team.update"
              ? action.workerId
              : action.kind === "team.add"
                ? (action.workerId ??
                  config.workers.find(
                    (w) =>
                      w.id > 3 &&
                      !relays.snapshot.teams.some((t) => t.workerId === w.id),
                  )?.id)
                : undefined;
          requireValue(
            workerId !== undefined,
            "NO_AVAILABLE_WORKER",
            "Không còn bot account trống.",
          );
          // Bind the permission-checked worker; a concurrent command must not substitute another bot.
          if (action.kind === "team.add") action.workerId = workerId;
          const botGuild = workerId
            ? runtime.controlWorkerGuild(workerId)
            : undefined;
          const me = await botGuild?.members.fetchMe({ force: true });
          const identity = (
            await pool.query(
              "SELECT user_id FROM relay_workers WHERE guild_id=$1 AND worker_id=$2",
              [guild.id, workerId],
            )
          ).rows[0]?.user_id;
          requireValue(
            me && identity === me.id,
            "BOT_IDENTITY_UNVERIFIED",
            "Chưa xác minh danh tính worker.",
          );
          requireValue(
            me &&
              channel
                ?.permissionsFor(me)
                ?.has([
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.Connect,
                  PermissionFlagsBits.Speak,
                ]),
            "MISSING_PERMISSIONS",
            "Bot chưa sẵn sàng hoặc thiếu quyền voice.",
          );
        }
        await relays.mutate(action, actorId);
        cache = undefined;
      }
      const result = {
        id: operationId,
        status: "Applied",
        message:
          "Cấu hình đã được lưu; xem trạng thái kết nối thực tế trên dashboard.",
      };
      await pool.query(
        "UPDATE dashboard_operations SET status='Applied',result=$2,updated_at=now() WHERE id=$1",
        [operationId, result],
      );
      return json(res, 200, result);
    } catch (error) {
      const uncertain =
        error instanceof CommitUncertainError ||
        !(error instanceof UserError || error instanceof ControlError);
      const message =
        error instanceof UserError || error instanceof ControlError
          ? error.message
          : "Chưa xác định được kết quả. Kiểm tra trạng thái trước khi thử lại.";
      await pool
        .query(
          "UPDATE dashboard_operations SET status=$2,result=$3,updated_at=now() WHERE id=$1",
          [
            operationId,
            uncertain ? "Unknown" : "Failed",
            JSON.stringify({ message }),
          ],
        )
        .catch(onError);
      await audit(
        actorId,
        path,
        operationId,
        { message },
        uncertain ? "Unknown" : "Failed",
      ).catch(onError);
      throw error;
    }
  }
  const lastBotStates = new Map<number, string>();
  const healthTimer = setInterval(() => {
    if (closing) return;
    for (const bot of config.workers) {
      const status = runtime.workerStatus(bot.id);
      const key = JSON.stringify([
        status?.gateway,
        status?.voice,
        status?.lastError,
      ]);
      const before = lastBotStates.get(bot.id);
      lastBotStates.set(bot.id, key);
      if (before && before !== key)
        void audit("system", "bot.status", String(bot.id), {
          before: JSON.parse(before),
          after: JSON.parse(key),
          workerId: bot.id,
        }).catch(onError);
    }
  }, 5000);
  healthTimer.unref();
  return {
    handler(req: IncomingMessage, res: ServerResponse) {
      const task = handle(req, res).catch((error) => {
        if (!(error instanceof ControlError || error instanceof UserError))
          onError(error);
        if (!res.headersSent)
          json(
            res,
            error instanceof ControlError
              ? error.status
              : error instanceof UserError
                ? 409
                : 503,
            {
              error: {
                code:
                  error instanceof ControlError
                    ? error.code
                    : error instanceof UserError
                      ? "CONFLICT"
                      : "WORKER_UNAVAILABLE",
                message:
                  error instanceof ControlError || error instanceof UserError
                    ? error.message
                    : "Worker tạm thời không sẵn sàng. Kiểm tra trạng thái thao tác trước khi thử lại.",
              },
            },
          );
      });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },
    async stop() {
      closing = true;
      clearInterval(healthTimer);
      await Promise.allSettled([...pending]);
    },
  };
}
export async function startControl(deps: Dependencies) {
  const secret = process.env.WORKER_CONTROL_SECRET;
  if (!secret) return undefined; // Existing deployments remain operational until configured.
  if (Buffer.byteLength(secret) < 32)
    throw new Error("WORKER_CONTROL_SECRET must contain at least 32 bytes");
  const port = Number(process.env.WORKER_CONTROL_PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid WORKER_CONTROL_PORT");
  const control = createControlHandler(deps, secret);
  const server = createServer(control.handler);
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "::", resolve);
    });
  } catch (error) {
    await control.stop();
    server.close();
    throw error;
  }

  return {
    async stop() {
      server.closeIdleConnections();
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      await control.stop();
      await closed;
    },
  };
}
