import "server-only";
import pg from "pg";
import { cookies } from "next/headers";
import { allowedOrigin, digest, sign, verifyToken } from "./security";
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function env(name: string) {
  const value = process.env[name];
  if (!value)
    throw new ApiError(
      503,
      "CONFIGURATION",
      `Dashboard chưa được cấu hình (${name}).`,
    );
  return value;
}
export function sessionKey() {
  const key = env("SESSION_SECRET");
  if (key.length < 32)
    throw new ApiError(
      503,
      "CONFIGURATION",
      "SESSION_SECRET cần ít nhất 32 ký tự.",
    );
  return key;
}
const globalPool = globalThis as unknown as { dashboardPool?: pg.Pool };
export function db() {
  if (!globalPool.dashboardPool) {
    const pool = new pg.Pool({
      connectionString: env("DATABASE_URL"),
      max: 5,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    pool.on("error", () =>
      console.error("Dashboard database connection unavailable"),
    );
    globalPool.dashboardPool = pool;
  }
  return globalPool.dashboardPool;
}
export const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
});
export interface User {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}
export async function session() {
  const token = (await cookies()).get("ct_session")?.value;
  if (!token || !verifyToken(token, sessionKey()))
    throw new ApiError(401, "UNAUTHENTICATED", "Hãy đăng nhập bằng Discord.");
  const row = (
    await db().query(
      "SELECT user_id,user_data,expires_at FROM dashboard_sessions WHERE token_hash=$1 AND expires_at>now()",
      [digest(token)],
    )
  ).rows[0];
  if (!row)
    throw new ApiError(
      401,
      "UNAUTHENTICATED",
      "Phiên đã hết hạn. Hãy đăng nhập lại.",
    );
  return {
    token,
    user: row.user_data as User,
    csrf: sign(`csrf:${token}`, sessionKey()),
  };
}
export async function requireMutation(request: Request) {
  const current = await session();
  if (!allowedOrigin(request, env("APP_URL"), current.csrf))
    throw new ApiError(
      403,
      "CSRF",
      "Phiên xác nhận không hợp lệ. Hãy tải lại trang.",
    );
  return current;
}
export async function worker(
  path: string,
  actor: string,
  init: RequestInit = {},
) {
  const base = new URL(env("WORKER_CONTROL_URL"));
  if (!["http:", "https:"].includes(base.protocol))
    throw new ApiError(
      503,
      "CONFIGURATION",
      "WORKER_CONTROL_URL không hợp lệ.",
    );
  let response: Response;
  try {
    response = await fetch(`${base.origin}/internal/v1${path}`, {
      ...init,
      cache: "no-store",
      redirect: "error",
      headers: {
        ...init.headers,
        authorization: `Bearer ${env("WORKER_CONTROL_SECRET")}`,
        "x-actor-id": actor,
        "content-type": "application/json",
      },
      signal:
        init.signal ??
        AbortSignal.timeout(path === "/moves/preview" ? 65000 : 20000),
    });
  } catch {
    throw new ApiError(
      503,
      "WORKER_OFFLINE",
      "Không kết nối được worker. Kết quả thao tác có thể chưa xác định; hãy kiểm tra lại trước khi gửi thao tác mới.",
    );
  }
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      response.status,
      data?.error?.code ?? "CONTROL_ERROR",
      data?.error?.message ??
        data?.result?.message ??
        "Thao tác chưa hoàn tất.",
    );
  return { data, status: response.status };
}
export function failure(error: unknown) {
  const known = error instanceof ApiError;
  if (!known) console.error("Dashboard request failed");
  return Response.json(
    {
      error: {
        code: known ? error.code : "UNAVAILABLE",
        message: known ? error.message : "Dịch vụ tạm thời không sẵn sàng.",
      },
    },
    {
      status: known ? error.status : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
export const noStore = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const attempts = new Map<string, { count: number; until: number }>();
export function authRateLimit(request: Request) {
  const now = Date.now();
  for (const [key, value] of attempts)
    if (value.until < now) attempts.delete(key);
  const id =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!attempts.has(id) && attempts.size > 2000)
    throw new ApiError(429, "RATE_LIMIT", "Hãy thử lại sau.");
  const value = attempts.get(id) ?? { count: 0, until: now + 60000 };
  attempts.set(id, value);
  if (++value.count > 15)
    throw new ApiError(
      429,
      "RATE_LIMIT",
      "Quá nhiều lần đăng nhập. Hãy thử lại sau.",
    );
}
