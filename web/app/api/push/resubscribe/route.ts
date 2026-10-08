import { authorizePushRequest, deviceMeta, jsonResponse } from '@/lib/push-api';
import { parseResubscribeBody } from '@/lib/push';
import { removePushSubscription, savePushSubscription } from '@/lib/push-subscriptions';

export const dynamic = 'force-dynamic';

/**
 * POST /api/push/resubscribe (called by the service worker on `pushsubscriptionchange`)
 * Body: { oldEndpoint?: string | null, subscription: <PushSubscription.toJSON()> }
 * Deletes the old endpoint of the session user (when given and different) and upserts the new one.
 * Responses: 200 { ok: true } | 400 | 401 | 403 | 413 | 415 | 502 (all JSON).
 */
export async function POST(request: Request) {
  const auth = await authorizePushRequest(request);
  if (!auth.ok) return auth.response;

  const parsed = parseResubscribeBody(auth.body);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);
  const { oldEndpoint, subscription } = parsed.value;

  try {
    if (oldEndpoint && oldEndpoint !== subscription.endpoint) {
      await removePushSubscription(auth.user.id, oldEndpoint);
    }
    await savePushSubscription(auth.user.id, subscription, deviceMeta(request, subscription.platform));
  } catch {
    return jsonResponse({ error: 'No se pudo actualizar la suscripción.' }, 502);
  }
  return jsonResponse({ ok: true });
}
