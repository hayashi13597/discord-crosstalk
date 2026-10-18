import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  cookieGet: vi.fn(),
  cookieSet: vi.fn(),
  cookieDelete: vi.fn(),
}));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      on() {}
      query = mocks.query;
    },
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: mocks.cookieGet,
    set: mocks.cookieSet,
    delete: mocks.cookieDelete,
  }),
}));
import { digest, signedToken, sign } from "../lib/security";
import { session, requireMutation, worker } from "../lib/server";
import { GET as callback } from "../app/api/auth/discord/callback/route";
import { POST as logout } from "../app/api/auth/logout/route";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
function configure() {
  vi.stubEnv("DATABASE_URL", "postgresql://test");
  vi.stubEnv("SESSION_SECRET", "s".repeat(64));
  vi.stubEnv("APP_URL", "https://admin.example");
  vi.stubEnv("WORKER_CONTROL_URL", "http://worker:3100");
  vi.stubEnv("WORKER_CONTROL_SECRET", "private-control-secret");
}
describe("authenticated server boundary", () => {
  it("rejects absent, invalid and expired sessions", async () => {
    configure();
    mocks.cookieGet.mockReturnValue(undefined);
    await expect(session()).rejects.toMatchObject({ status: 401 });
    mocks.cookieGet.mockReturnValue({ value: "tampered" });
    await expect(session()).rejects.toMatchObject({ status: 401 });
    mocks.cookieGet.mockReturnValue({ value: signedToken("s".repeat(64)) });
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(session()).rejects.toMatchObject({ status: 401 });
  });
  it("enforces CSRF before logout or mutation", async () => {
    configure();
    const token = signedToken("s".repeat(64));
    mocks.cookieGet.mockReturnValue({ value: token });
    mocks.query.mockResolvedValue({ rows: [{ user_data: { id: "123" } }] });
    await expect(
      requireMutation(
        new Request("https://admin.example/api", { method: "POST" }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const response = await logout(
      new Request("https://admin.example/api/auth/logout", {
        method: "POST",
        headers: {
          origin: "https://admin.example",
          "x-csrf-token": sign(`csrf:${token}`, "s".repeat(64)),
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(
      "DELETE FROM dashboard_sessions WHERE token_hash=$1",
      [digest(token)],
    );
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      "ct_session",
      "",
      expect.objectContaining({ maxAge: 0, httpOnly: true }),
    );
  });
  it("rejects OAuth state replay before contacting Discord", async () => {
    configure();
    const state = signedToken("s".repeat(64));
    mocks.cookieGet.mockReturnValue({ value: state });
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await callback(
      new Request(
        `https://admin.example/api/auth/discord/callback?state=${state}&code=test`,
      ),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("OAUTH_CANCELLED");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses server-held control credentials and never forwards browser cookies", async () => {
    configure();
    const fetch = vi.fn(async () => Response.json({ access: {} }));
    vi.stubGlobal("fetch", fetch);
    await worker("/access", "123456789012345678");
    expect(fetch).toHaveBeenCalledWith(
      "http://worker:3100/internal/v1/access",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer private-control-secret",
          "x-actor-id": "123456789012345678",
        }),
        cache: "no-store",
        redirect: "error",
      }),
    );
  });
  it("converts worker failures into a clear offline error without leaking transport details", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("secret internal transport details");
      }),
    );
    await expect(
      worker("/snapshot", "123456789012345678"),
    ).rejects.toMatchObject({ status: 503, code: "WORKER_OFFLINE" });
  });
});

describe("OAuth success", () => {
  it("creates a signed secure session only after worker authorization and encrypts OAuth tokens", async () => {
    configure();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DISCORD_CLIENT_ID", "test-client");
    vi.stubEnv("DISCORD_CLIENT_SECRET", "test-secret");
    vi.stubEnv(
      "DISCORD_REDIRECT_URI",
      "https://admin.example/api/auth/discord/callback",
    );
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "ab".repeat(32));
    const state = signedToken("s".repeat(64));
    mocks.cookieGet.mockReturnValue({ value: state });
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "private-oauth-token",
          refresh_token: "private-refresh-token",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "123456789012345678",
          username: "admin",
          avatar: null,
        }),
      )
      .mockResolvedValueOnce(Response.json({ access: { read: true } }));
    vi.stubGlobal("fetch", fetch);
    const response = await callback(
      new Request(
        `https://admin.example/api/auth/discord/callback?state=${state}&code=code`,
      ),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://admin.example/");
    expect(fetch).toHaveBeenCalledTimes(3);
    const insert = mocks.query.mock.calls.find((call) =>
      call[0].includes("INSERT INTO dashboard_sessions"),
    );
    expect(insert?.[1][3]).not.toContain("private-oauth-token");
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      "ct_session",
      expect.any(String),
      expect.objectContaining({
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        maxAge: 604800,
      }),
    );
    const cookie = mocks.cookieSet.mock.calls[0][1];
    expect(insert?.[1][0]).toBe(digest(cookie));
  });
});

describe("SSE transport", () => {
  it("streams the first authorized runtime snapshot without waiting for the stream lifetime", async () => {
    configure();
    const token = signedToken("s".repeat(64));
    mocks.cookieGet.mockReturnValue({ value: token });
    mocks.query.mockResolvedValue({
      rows: [{ user_data: { id: "123456789012345678" } }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ updatedAt: "now", groups: [] })),
    );
    const { GET } = await import("../app/api/events/route");
    const abort = new AbortController();
    const response = await GET(
      new Request("https://admin.example/api/events", { signal: abort.signal }),
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: snapshot");
    abort.abort();
    await reader.cancel();
  });
});
