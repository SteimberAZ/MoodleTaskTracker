import { hmacHex, safeEqual } from './session-token';
import { sanitizeClasses, sanitizePeriodEnd, sanitizePeriodLabel } from './class-schedule';
import type { ScheduleClass } from './sga-schedule';

/**
 * The parsed schedule travels from the upload step to the confirm step inside a hidden field. It is signed
 * (HMAC, bound to the session user and short lived) so the client cannot swap in another user's id or stale
 * data, and it is validated again on save; the PDF itself is never stored.
 */

export const PREVIEW_TTL_MS = 30 * 60 * 1000;
const LABEL = 'moddle-class-schedule-preview-v1';

export interface SchedulePreviewData {
  periodLabel: string | null;
  periodEnd: string | null;
  classes: ScheduleClass[];
}

const signingKey = (secret: string) => hmacHex(secret, LABEL);

export async function signSchedulePreview(
  secret: string,
  userId: string,
  data: SchedulePreviewData,
  nowMs: number = Date.now(),
): Promise<string> {
  if (!secret) throw new Error('Missing signing secret');
  const payload = Buffer.from(
    JSON.stringify({ v: 1, uid: userId, exp: nowMs + PREVIEW_TTL_MS, label: data.periodLabel, end: data.periodEnd, classes: data.classes }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${await hmacHex(await signingKey(secret), payload)}`;
}

/** Returns the validated data, or null when the token is forged, expired, issued to another user or malformed. */
export async function verifySchedulePreview(
  secret: string | undefined,
  userId: string,
  token: unknown,
  nowMs: number = Date.now(),
): Promise<SchedulePreviewData | null> {
  if (!secret || typeof token !== 'string' || token.length > 200_000) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!(await safeEqual(await hmacHex(await signingKey(secret), payload), signature))) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (body.v !== 1 || body.uid !== userId || typeof body.exp !== 'number' || body.exp <= nowMs) return null;
    const classes = sanitizeClasses(body.classes);
    if (classes.length === 0) return null;
    return { periodLabel: sanitizePeriodLabel(body.label), periodEnd: sanitizePeriodEnd(body.end), classes };
  } catch {
    return null;
  }
}
