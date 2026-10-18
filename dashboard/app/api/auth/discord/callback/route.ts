import { cookies } from "next/headers";
import {
  ApiError,
  authRateLimit,
  cookieOptions,
  db,
  env,
  failure,
  sessionKey,
  worker,
  type User,
} from "@/lib/server";
import {
  digest,
  encrypt,
  equal,
  signedToken,
  verifyToken,
} from "@/lib/security";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    authRateLimit(request);
    const url = new URL(request.url),
      jar = await cookies();
    const state = url.searchParams.get("state") ?? "";
    const cookie = jar.get("ct_oauth")?.value ?? "";
    jar.delete("ct_oauth");
    if (!cookie || !equal(state, cookie) || !verifyToken(state, sessionKey()))
      throw new ApiError(
        400,
        "INVALID_STATE",
        "Phiên OAuth không hợp lệ. Hãy đăng nhập lại.",
      );
    const consumed = await db().query(
      "DELETE FROM dashboard_oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING state_hash",
      [digest(state)],
    );
    if (
      !consumed.rowCount ||
      !url.searchParams.get("code") ||
      url.searchParams.has("error")
    )
      throw new ApiError(
        400,
        "OAUTH_CANCELLED",
        "Đăng nhập đã bị hủy hoặc hết hạn.",
      );
    const response = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env("DISCORD_CLIENT_ID"),
        client_secret: env("DISCORD_CLIENT_SECRET"),
        grant_type: "authorization_code",
        code: url.searchParams.get("code")!,
        redirect_uri: env("DISCORD_REDIRECT_URI"),
      }),
    });
    if (!response.ok)
      throw new ApiError(
        401,
        "OAUTH_FAILED",
        "Không thể xác thực với Discord.",
      );
    const tokens = await response.json();
    const profile = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!profile.ok)
      throw new ApiError(
        401,
        "OAUTH_FAILED",
        "Không lấy được tài khoản Discord.",
      );
    const raw = await profile.json();
    const user: User = {
      id: raw.id,
      username: raw.username,
      global_name: raw.global_name,
      avatar: raw.avatar,
    };
    if (!/^\d{17,20}$/.test(user.id))
      throw new ApiError(401, "OAUTH_FAILED", "Tài khoản không hợp lệ.");
    await worker("/access", user.id); // Membership and permissions verified by the existing bot.
    const token = signedToken(sessionKey());
    await db().query(
      "INSERT INTO dashboard_sessions(token_hash,user_id,user_data,oauth_tokens,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days')",
      [
        digest(token),
        user.id,
        JSON.stringify(user),
        encrypt(tokens, env("TOKEN_ENCRYPTION_KEY")),
      ],
    );
    jar.set("ct_session", token, { ...cookieOptions(), maxAge: 7 * 86400 });
    return Response.redirect(new URL("/", env("APP_URL")));
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "UNAVAILABLE";
    try {
      return Response.redirect(
        new URL(`/?auth_error=${encodeURIComponent(code)}`, env("APP_URL")),
      );
    } catch {
      return failure(error);
    }
  }
}
