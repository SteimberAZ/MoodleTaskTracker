export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Minimal per-key cooldown. State lives in the caller's map (in-memory, per server instance),
 * which is enough to stop accidental double clicks; it is not a security boundary.
 */
export function checkCooldown(
  lastCalls: Map<string, number>,
  key: string,
  nowMs: number,
  windowMs: number,
): RateLimitResult {
  const last = lastCalls.get(key);
  if (last !== undefined && nowMs - last < windowMs) {
    return { allowed: false, retryAfterSeconds: Math.ceil((windowMs - (nowMs - last)) / 1000) };
  }
  lastCalls.set(key, nowMs);
  if (lastCalls.size > 1000) {
    for (const [k, t] of lastCalls) if (nowMs - t >= windowMs) lastCalls.delete(k);
  }
  return { allowed: true, retryAfterSeconds: 0 };
}
