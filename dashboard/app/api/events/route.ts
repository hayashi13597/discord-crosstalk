import { failure, session, worker } from "@/lib/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await session();
    const encoder = new TextEncoder();
    let stopped = false;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          if (!stopped)
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
        };
        const abort = () => {
          stopped = true;
        };
        request.signal.addEventListener("abort", abort, { once: true });
        try {
          // Bound stream lifetime; EventSource reconnect revalidates the cookie/session.
          const deadline = Date.now() + 55000;
          while (!stopped && Date.now() < deadline) {
            try {
              const current = await session();
              const { data } = await worker("/snapshot", current.user.id);
              send("snapshot", data);
            } catch {
              send("offline", {
                message: "Dữ liệu chưa cập nhật. Đang kết nối lại worker.",
              });
              break;
            }
            await new Promise<void>((resolve) => {
              const timer = setTimeout(done, 2000);
              function done() {
                clearTimeout(timer);
                request.signal.removeEventListener("abort", done);
                resolve();
              }
              request.signal.addEventListener("abort", done, { once: true });
            });
          }
        } finally {
          stopped = true;
          request.signal.removeEventListener("abort", abort);
          try {
            controller.close();
          } catch {}
        }
      },
      cancel() {
        stopped = true;
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
