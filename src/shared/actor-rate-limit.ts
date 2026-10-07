import { fail } from "./errors.js";

/**
 * Sliding-window limiter keyed by authenticated actor + action, for privileged re-authentication attempts.
 * The per-IP route limit stays as a second defence. In memory: per process (CORECROW runs one API instance);
 * move to a shared store before scaling horizontally.
 */
const windows = new Map<string, number[]>();

export function consumeActorAttempt(actorId: string, action: string, max = 5, windowMs = 60_000, now = Date.now()) {
  const key = `${action}:${actorId}`;
  const recent = (windows.get(key) ?? []).filter((time) => now - time < windowMs);
  if (recent.length >= max) {
    windows.set(key, recent);
    fail(429, "RATE_LIMITED", "Too many attempts; try again shortly");
  }
  recent.push(now);
  windows.set(key, recent);
}

export const resetActorRateLimits = () => windows.clear();
