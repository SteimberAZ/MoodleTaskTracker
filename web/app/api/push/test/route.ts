import { authorizePushRequest, jsonResponse } from '@/lib/push-api';
import { parseEndpointBody } from '@/lib/push';
import { requestPushTest } from '@/lib/push-subscriptions';
import { checkCooldown } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const TEST_COOLDOWN_MS = 30_000;
// Per server instance: enough to stop double clicks and accidental spam, not a security boundary.
const lastTest = new Map<string, number>();

/**
 * POST /api/push/test
 * Body: { endpoint }
 * Sets `test_requested_at = now` on that device of the session user; the VPS worker sends the push within ~1 minute.
 * Responses: 200 { ok: true } | 400 | 401 | 403 | 404 (device not registered) | 413 | 415 | 429 { retryAfterSeconds } | 502.
 */
export async function POST(request: Request) {
  const auth = await authorizePushRequest(request);
  if (!auth.ok) return auth.response;

  const parsed = parseEndpointBody(auth.body);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);

  const limit = checkCooldown(lastTest, auth.user.id, Date.now(), TEST_COOLDOWN_MS);
  if (!limit.allowed) {
    return jsonResponse({ error: 'Espera unos segundos antes de otra prueba.', retryAfterSeconds: limit.retryAfterSeconds }, 429);
  }

  try {
    if (!(await requestPushTest(auth.user.id, parsed.value.endpoint))) {
      return jsonResponse({ error: 'Este dispositivo no está registrado.' }, 404);
    }
  } catch {
    return jsonResponse({ error: 'No se pudo solicitar la prueba.' }, 502);
  }
  return jsonResponse({ ok: true });
}
