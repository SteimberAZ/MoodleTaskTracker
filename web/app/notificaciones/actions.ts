'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth';
import { clearHistory } from '@/lib/notification-history';
import { NOTIFICATIONS_PATH } from '@/lib/notification-log';

export interface ClearHistoryState {
  error?: string;
}

/** "Borrar historial": deletes the session user's notification log only; the owner never comes from the form. */
export async function clearNotificationHistory(_prev: ClearHistoryState, _formData: FormData): Promise<ClearHistoryState> {
  const user = await requireUser();
  try {
    await clearHistory(user.id);
  } catch {
    return { error: 'No se pudo borrar el historial. Inténtalo de nuevo.' };
  }
  revalidatePath(NOTIFICATIONS_PATH);
  return {};
}
