import {
  ApiError,
  failure,
  noStore,
  requireMutation,
  session,
  worker,
} from "@/lib/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function proxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const current =
      request.method === "POST"
        ? await requireMutation(request)
        : await session();
    const { path } = await context.params;
    if (!path.length || path.some((p) => !/^[a-zA-Z0-9-]+$/.test(p)))
      throw new ApiError(400, "INVALID_PATH", "Đường dẫn không hợp lệ.");
    let body: string | undefined;
    if (request.method === "POST") {
      if (Number(request.headers.get("content-length")) > 128 * 1024)
        throw new ApiError(413, "BODY_TOO_LARGE", "Request quá lớn.");
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 128 * 1024) {
            await reader.cancel();
            throw new ApiError(413, "BODY_TOO_LARGE", "Request quá lớn.");
          }
          chunks.push(value);
        }
      body = Buffer.concat(chunks).toString() || "{}";
    }
    const url = new URL(request.url);
    const { data, status } = await worker(
      `/${path.join("/")}${url.search}`,
      current.user.id,
      {
        method: request.method,
        body,
        headers: {
          "idempotency-key": request.headers.get("idempotency-key") ?? "",
        },
      },
    );
    return Response.json(data, { status, headers: noStore });
  } catch (error) {
    return failure(error);
  }
}
export const GET = proxy;
export const POST = proxy;
