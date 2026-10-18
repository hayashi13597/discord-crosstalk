import { failure, noStore, session, worker } from "@/lib/server";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const current = await session();
    const { data } = await worker("/access", current.user.id);
    return Response.json(
      { user: current.user, csrf: current.csrf, ...data },
      { headers: noStore },
    );
  } catch (error) {
    return failure(error);
  }
}
