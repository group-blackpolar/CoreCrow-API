import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Network } from "../../shared/request-context.js";

export const DEVICE_COOKIE = "bp_device";
export const deviceHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const newDeviceToken = () => randomBytes(32).toString("base64url");
const tokenShape = /^[A-Za-z0-9_-]{43}$/;

/** Network facts of a request. `request.ip` already honors only the configured trusted proxies. */
export function networkOf(request: FastifyRequest): Network {
  const cookie = (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies?.[DEVICE_COOKIE];
  const header = request.headers["x-device-token"];
  const candidate = cookie ?? (typeof header === "string" ? header : undefined);
  return {
    ip: request.ip ?? null,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"].slice(0, 300) : null,
    deviceToken: candidate && tokenShape.test(candidate) ? candidate : null,
    outcome: {},
  };
}

export function deviceCookie(token: string) {
  const secure = (process.env.BETTER_AUTH_URL ?? "").startsWith("https://");
  return `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${60 * 60 * 24 * 365}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
