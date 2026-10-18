import { cookies } from "next/headers";
import {
  cookieOptions,
  db,
  failure,
  noStore,
  requireMutation,
} from "@/lib/server";
import { digest } from "@/lib/security";
export async function POST(request: Request) {
  try {
    const current = await requireMutation(request);
    await db().query("DELETE FROM dashboard_sessions WHERE token_hash=$1", [
      digest(current.token),
    ]);
    (await cookies()).set("ct_session", "", { ...cookieOptions(), maxAge: 0 });
    return Response.json({ ok: true }, { headers: noStore });
  } catch (error) {
    return failure(error);
  }
}
