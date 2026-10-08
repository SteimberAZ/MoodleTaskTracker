'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth';
import { setNtfyEnabled, setUserTopic } from '@/lib/users';
import { checkCooldown } from '@/lib/rate-limit';
import { generateNtfyTopic, resolveNtfyServer } from '@/lib/random';
import { confirmNtfy } from '@/lib/ntfy-status';
import { countUserPushDevices } from '@/lib/push-subscriptions';

export interface TestPushState {
  ok?: boolean;
  message?: string;
}

const TEST_COOLDOWN_MS = 30_000;
const NTFY_TIMEOUT_MS = 10_000;
// Per server instance: enough to stop double clicks and accidental spam, not a security boundary.
const lastTestPush = new Map<string, number>();

/** "Probar ntfy": publishes a test message to the user's topic; a successful publish confirms ntfy. */
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
  // A missing ntfy_confirmed_at column (migration pending) or a failed write never fails the test.
  if ((await confirmNtfy(user.id)) === true) revalidatePath('/cuenta');
  return { ok: true, message: 'Notificación enviada. Si estás suscrito al tema, debería llegar en unos segundos.' };
}

export interface NtfyConfirmState {
  confirmed?: boolean;
  error?: string;
}

/** "Ya me suscribí en la app ntfy": the user confirms they receive the topic, so ntfy counts as delivered. */
export async function confirmNtfySubscription(_prev: NtfyConfirmState, _formData: FormData): Promise<NtfyConfirmState> {
  const user = await requireUser();
  const result = await confirmNtfy(user.id);
  if (result !== true) return { error: 'No se pudo guardar la confirmación. Inténtalo de nuevo.' };
  revalidatePath('/cuenta');
  revalidatePath('/notificaciones');
  return { confirmed: true };
}

export interface RegenerateTopicState {
  ok?: boolean;
  error?: string;
}

/** Replaces the topic with a fresh random one. The old subscription stops receiving messages. */
export async function regenerateTopic(_prev: RegenerateTopicState, _formData: FormData): Promise<RegenerateTopicState> {
  const user = await requireUser();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await setUserTopic(user.id, generateNtfyTopic())) {
        // The new topic has no subscriber yet: ntfy stops counting as delivered until it is confirmed again.
        await confirmNtfy(user.id, false);
        revalidatePath('/cuenta');
        return { ok: true };
      }
    }
  } catch {
    // Reported below.
  }
  return { error: 'No se pudo regenerar el tema. Inténtalo de nuevo.' };
}

export interface NtfyToggleState {
  /** The value that was saved; undefined until the first successful change. */
  enabled?: boolean;
  error?: string;
  /** Saved, but the user is left without any channel (ntfy off and no push device). */
  warning?: string;
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
  revalidatePath('/notificaciones');
  if (!enabled && (await countUserPushDevices(user.id)) === 0) {
    return {
      enabled,
      warning: 'Sin ntfy y sin dispositivos con notificaciones Push no recibirás avisos. Actívalas en algún dispositivo.',
    };
  }
  return { enabled };
}
