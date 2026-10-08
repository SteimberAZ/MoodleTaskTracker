import { authorizePushRequest, jsonResponse } from '@/lib/push-api';
import { parseEndpointBody } from '@/lib/push';
import { requestPushTest } from '@/lib/push-subscriptions';
import { checkCooldown } from '@/lib/rate-limit';
import { getWorkerStatus, testPushWarning } from '@/lib/worker-status';

export const dynamic = 'force-dynamic';

const TEST_COOLDOWN_MS = 30_000;
// Per server instance: enough to stop double clicks and accidental spam, not a security boundary.
const lastTest = new Map<string, number>();

/**
 * POST /api/push/test
 * Body: { endpoint }
 * Sets `test_requested_at = now` on that device of the session user; the VPS worker sends the push within ~1 minute.
 * The flag is set even when the worker heartbeat is stale or Web Push is disabled on it, but the answer then
 * carries `warning` so the device can say the test will not arrive soon.
 * Responses: 200 { ok: true, requestedAt, warning?: 'worker_stale' | 'push_disabled' } | 400 | 401 | 403
 *          | 404 (device not registered) | 413 | 415 | 429 { retryAfterSeconds } | 502.
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

  const now = new Date();
  const requestedAt = now.toISOString();
  // The heartbeat read runs alongside the flag write; a failed read only means "no warning".
  const status = getWorkerStatus().catch(() => null);
  try {
    if (!(await requestPushTest(auth.user.id, parsed.value.endpoint, requestedAt))) {
      return jsonResponse({ error: 'Este dispositivo no está registrado.' }, 404);
    }
  } catch {
    return jsonResponse({ error: 'No se pudo solicitar la prueba.' }, 502);
  }
  const warning = testPushWarning((await status)?.heartbeat ?? null, now);
  return jsonResponse(warning ? { ok: true, requestedAt, warning } : { ok: true, requestedAt });
}
