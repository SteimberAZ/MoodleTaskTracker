import { authorizePushSession, jsonResponse } from '@/lib/push-api';
import { isPlausibleEndpoint } from '@/lib/push';
import { getPushStatus } from '@/lib/push-subscriptions';

export const dynamic = 'force-dynamic';

/**
 * GET /api/push/status?endpoint=<this device's endpoint>
 * What the server knows about one device of the session user (never another user's: the read is scoped by
 * user_id). Lets the device tell "Activas" apart from "subscribed in the browser but not registered".
 * Responses: 200 { registered, last_success_at, last_failure_at, failure_count, last_failure_reason, test_requested_at }
 *          | 400 | 401 | 403 | 502 | 503 (all JSON, no-store).
 */
export async function GET(request: Request) {
  const auth = await authorizePushSession(request);
  if (!auth.ok) return auth.response;

  const endpoint = new URL(request.url).searchParams.get('endpoint');
  if (!isPlausibleEndpoint(endpoint)) return jsonResponse({ error: 'Endpoint inválido.' }, 400);

  try {
    return jsonResponse({ ...(await getPushStatus(auth.user.id, endpoint)) });
  } catch {
    return jsonResponse({ error: 'No se pudo leer el estado del dispositivo.' }, 502);
  }
}
