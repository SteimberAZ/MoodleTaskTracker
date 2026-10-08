'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth';
import { createInvite, revokeInvite as removeInvite } from '@/lib/invites';
import { parseExpiryDays } from '@/lib/invite-status';
import { normalizeInviteCode } from '@/lib/random';
import { isUuid } from '@/lib/queries';
import { setUserActive } from '@/lib/users';

export interface InviteFormState {
  error?: string;
  created?: string;
}

// Server actions are public endpoints: each one re-checks that the caller is an admin.

export async function createInviteAction(_prev: InviteFormState, formData: FormData): Promise<InviteFormState> {
  const admin = await requireAdmin();
  const days = parseExpiryDays(String(formData.get('days') ?? ''));
  if (days === undefined) return { error: 'La vigencia debe ser un número de días entre 1 y 365.' };
  const expiresAt = days === null ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  try {
    const code = await createInvite(admin.id, expiresAt);
    revalidatePath('/admin');
    return { created: code };
  } catch {
    return { error: 'No se pudo crear la invitación. Inténtalo de nuevo.' };
  }
}

export async function revokeInvite(code: string): Promise<void> {
  await requireAdmin();
  const normalized = normalizeInviteCode(code);
  if (!normalized) return;
  await removeInvite(normalized);
  revalidatePath('/admin');
}

export async function setActive(userId: string, active: boolean): Promise<void> {
  const admin = await requireAdmin();
  if (!isUuid(userId)) return;
  // An admin cannot lock themselves out.
  if (userId === admin.id) return;
  await setUserActive(userId, active);
  revalidatePath('/admin');
}
