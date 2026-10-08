import { authorizePushRequest, jsonResponse } from '@/lib/push-api';
import { parseEndpointBody } from '@/lib/push';
import { removePushSubscription } from '@/lib/push-subscriptions';

export const dynamic = 'force-dynamic';

/**
 * POST /api/push/unsubscribe
 * Body: { endpoint }
 * Deletes `endpoint=eq.<endpoint>&user_id=eq.<me>`; removing a device that is already gone is a success.
 * Responses: 200 { ok: true } | 400 | 401 | 403 | 413 | 415 | 502 (all JSON).
 */
export async function POST(request: Request) {
  const auth = await authorizePushRequest(request);
  if (!auth.ok) return auth.response;

  const parsed = parseEndpointBody(auth.body);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);

  try {
    await removePushSubscription(auth.user.id, parsed.value.endpoint);
  } catch {
    return jsonResponse({ error: 'No se pudo quitar la suscripción.' }, 502);
  }
  return jsonResponse({ ok: true });
}
