import { authorizePushRequest, deviceMeta, jsonResponse } from '@/lib/push-api';
import { parseSubscribeBody } from '@/lib/push';
import { savePushSubscription } from '@/lib/push-subscriptions';

export const dynamic = 'force-dynamic';

/**
 * POST /api/push/subscribe
 * Body: the JSON of `PushSubscription.toJSON()` plus an optional platform hint:
 *   { endpoint, expirationTime?, keys: { p256dh, auth }, platform?: 'ios' | 'android' | 'desktop', resetFailures?: true }
 * Upserts by endpoint for the session user (the owner never comes from the body) and keeps the newest ten devices.
 * `resetFailures: true` is sent only by an explicit activation and resets `failure_count` to 0.
 * Responses: 200 { ok: true } | 400 | 401 | 403 | 413 | 415 | 502 (all JSON).
 */
export async function POST(request: Request) {
  const auth = await authorizePushRequest(request);
  if (!auth.ok) return auth.response;

  const parsed = parseSubscribeBody(auth.body);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);

  try {
    await savePushSubscription(auth.user.id, parsed.value, deviceMeta(request, parsed.value.platform), {
      resetFailures: parsed.value.resetFailures === true,
    });
  } catch {
    return jsonResponse({ error: 'No se pudo guardar la suscripción.' }, 502);
  }
  return jsonResponse({ ok: true });
}
