import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function sign(value: string, key: string) {
  return createHmac("sha256", key).update(value).digest("base64url");
}
export function signedToken(key: string) {
  const value = randomToken();
  return `${value}.${sign(value, key)}`;
}
export function verifyToken(token: string, key: string) {
  const [value, mac, extra] = token.split(".");
  return !extra && !!value && !!mac && equal(mac, sign(value, key));
}
export function encrypt(value: unknown, hexKey: string) {
  if (!/^[a-f0-9]{64}$/i.test(hexKey))
    throw new Error("Invalid token encryption key");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}
export function decrypt<T>(value: string, hexKey: string): T {
  const raw = Buffer.from(value, "base64url");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(hexKey, "hex"),
    raw.subarray(0, 12),
  );
  cipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString(
      "utf8",
    ),
  ) as T;
}
export function allowedOrigin(request: Request, appUrl: string, csrf: string) {
  return (
    request.headers.get("origin") === new URL(appUrl).origin &&
    equal(request.headers.get("x-csrf-token") ?? "", csrf)
  );
}
