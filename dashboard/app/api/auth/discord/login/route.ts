import { cookies } from "next/headers";
import {
  authRateLimit,
  cookieOptions,
  db,
  env,
  failure,
  sessionKey,
} from "@/lib/server";
import { digest, signedToken } from "@/lib/security";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    authRateLimit(request);
    const state = signedToken(sessionKey());
    await db().query(
      "DELETE FROM dashboard_oauth_states WHERE expires_at < now()",
    );
    await db().query("DELETE FROM dashboard_sessions WHERE expires_at < now()");
    await db().query(
      "INSERT INTO dashboard_oauth_states(state_hash,expires_at) VALUES($1,now()+interval '10 minutes')",
      [digest(state)],
    );
    (await cookies()).set("ct_oauth", state, {
      ...cookieOptions(),
      maxAge: 600,
    });
    const url = new URL("https://discord.com/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: env("DISCORD_CLIENT_ID"),
      redirect_uri: env("DISCORD_REDIRECT_URI"),
      response_type: "code",
      scope: "identify guilds",
      state,
    }).toString();
    return Response.redirect(url);
  } catch (error) {
    return failure(error);
  }
}
