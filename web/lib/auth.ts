import 'server-only';
import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import { getSessionUserId } from './session';
import { getUserById, type SessionUser } from './users';

/**
 * The signed cookie says who the session was issued to; the database says whether that
 * person may still use the app (row exists and is active).
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const user = await getUserById(userId);
  return user && user.active ? user : null;
});

/** For pages and server actions: redirects to /login when there is no usable session. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

/** Server actions are public endpoints: admin ones must call this themselves. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.is_admin) notFound();
  return user;
}
