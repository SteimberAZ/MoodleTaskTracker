'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth';
import { setNtfyEnabled, setUserTopic } from '@/lib/users';
import { checkCooldown } from '@/lib/rate-limit';
import { generateNtfyTopic, resolveNtfyServer } from '@/lib/random';

export interface TestPushState {
  ok?: boolean;
  message?: string;
}

const TEST_COOLDOWN_MS = 30_000;
const NTFY_TIMEOUT_MS = 10_000;
// Per server instance: enough to stop double clicks and accidental spam, not a security boundary.
const lastTestPush = new Map<string, number>();

export async function sendTestNotification(_prev: TestPushState, _formData: FormData): Promise<TestPushState> {
  const user = await requireUser();
  const limit = checkCooldown(lastTestPush, user.id, Date.now(), TEST_COOLDOWN_MS);
  if (!limit.allowed) {
    return { ok: false, message: `Espera ${limit.retryAfterSeconds} s antes de enviar otra prueba.` };
  }

  try {
    const res = await fetch(`${resolveNtfyServer(process.env.NTFY_SERVER)}/${encodeURIComponent(user.ntfy_topic)}`, {
      method: 'POST',
      headers: { Title: 'Prueba', Tags: 'bell' },
      body: 'Notificación de prueba: tus avisos de tareas llegarán aquí.',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, message: `ntfy respondió con un error (${res.status}). Inténtalo de nuevo.` };
  } catch {
    return { ok: false, message: 'No se pudo contactar con ntfy. Inténtalo de nuevo.' };
  }
  return { ok: true, message: 'Notificación enviada. Si estás suscrito al tema, debería llegar en unos segundos.' };
}

/** Replaces the topic with a fresh random one. The old subscription stops receiving messages. */
export async function regenerateTopic(): Promise<void> {
  const user = await requireUser();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await setUserTopic(user.id, generateNtfyTopic())) {
      revalidatePath('/cuenta');
      return;
    }
  }
  throw new Error('No se pudo regenerar el tema.');
}

export interface NtfyToggleState {
  /** The value that was saved; undefined until the first successful change. */
  enabled?: boolean;
  error?: string;
}

/** "Recibir también en la app ntfy": saves `moodle_users.ntfy_enabled` for the session user only. */
export async function setNtfyDelivery(_prev: NtfyToggleState, formData: FormData): Promise<NtfyToggleState> {
  const user = await requireUser();
  const raw = String(formData.get('enabled') ?? '');
  if (raw !== 'true' && raw !== 'false') return { error: 'Valor no válido.' };
  const enabled = raw === 'true';
  try {
    if (!(await setNtfyEnabled(user.id, enabled))) return { error: 'No se pudo guardar el cambio.' };
  } catch {
    return { error: 'No se pudo guardar el cambio. Inténtalo de nuevo.' };
  }
  revalidatePath('/cuenta');
  return { enabled };
}
