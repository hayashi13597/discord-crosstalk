import { describe, expect, it } from "vitest";
import {
  allowedOrigin,
  decrypt,
  digest,
  encrypt,
  signedToken,
  verifyToken,
} from "../lib/security";
describe("session and OAuth security", () => {
  const key = "ab".repeat(32);
  it("rejects tampered and differently signed session/state tokens", () => {
    const token = signedToken(key);
    expect(verifyToken(token, key)).toBe(true);
    expect(verifyToken(`${token}x`, key)).toBe(false);
    expect(verifyToken(token, "different")).toBe(false);
    expect(verifyToken(`${token}.extra`, key)).toBe(false);
    expect(verifyToken("", key)).toBe(false);
  });
  it("encrypts OAuth credentials with randomized authenticated encryption", () => {
    const tokens = {
      access_token: "private-token",
      refresh_token: "private-refresh",
    };
    const a = encrypt(tokens, key),
      b = encrypt(tokens, key);
    expect(a).not.toContain(tokens.access_token);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toEqual(tokens);
    expect(() => decrypt(a, "cd".repeat(32))).toThrow();
    const tampered = Buffer.from(a, "base64url");
    tampered[30] ^= 1;
    expect(() => decrypt(tampered.toString("base64url"), key)).toThrow();
    expect(() => encrypt(tokens, "short")).toThrow();
  });
  it("requires same-origin and the session-bound CSRF value", () => {
    const req = (origin: string, token: string) =>
      new Request("https://admin.example/api/control/groups", {
        headers: { origin, "x-csrf-token": token },
      });
    expect(
      allowedOrigin(
        req("https://admin.example", "csrf"),
        "https://admin.example",
        "csrf",
      ),
    ).toBe(true);
    expect(
      allowedOrigin(
        req("https://evil.example", "csrf"),
        "https://admin.example",
        "csrf",
      ),
    ).toBe(false);
    expect(
      allowedOrigin(
        req("https://admin.example", "other"),
        "https://admin.example",
        "csrf",
      ),
    ).toBe(false);
    expect(
      allowedOrigin(
        new Request("https://admin.example"),
        "https://admin.example",
        "csrf",
      ),
    ).toBe(false);
  });
  it("stores a digest instead of a usable bearer token", () => {
    const token = signedToken(key);
    expect(digest(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(digest(token)).not.toBe(token);
  });
});
