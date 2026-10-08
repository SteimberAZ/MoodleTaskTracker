import { authorizePushRequest, jsonResponse } from '@/lib/push-api';
import { parseEndpointBody } from '@/lib/push';
import { getPushStatus } from '@/lib/push-subscriptions';

export const dynamic = 'force-dynamic';

/**
 * POST /api/push/status
 * Body: { endpoint } (this device's endpoint). A POST body, not a query string: the endpoint is a capability
 * URL and query strings end up in access logs, proxies and the browser history.
 * What the server knows about one device of the session user (never another user's: the read is scoped by
 * user_id). Lets the device tell "Activas" apart from "subscribed in the browser but not registered".
 * Responses: 200 { registered, last_success_at, last_failure_at, failure_count, last_failure_reason, test_requested_at }
 *          | 400 | 401 | 403 | 413 | 415 | 502 | 503 (all JSON, no-store).
 */
export async function POST(request: Request) {
  const auth = await authorizePushRequest(request);
  if (!auth.ok) return auth.response;

  const parsed = parseEndpointBody(auth.body);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);

  try {
    return jsonResponse({ ...(await getPushStatus(auth.user.id, parsed.value.endpoint)) });
  } catch {
    return jsonResponse({ error: 'No se pudo leer el estado del dispositivo.' }, 502);
  }
}
