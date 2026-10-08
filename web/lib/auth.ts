import 'server-only';
import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import { getSessionUserId, requireSessionUserId } from './session';
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

/**
 * Page loader that overlaps the user lookup with the page's own reads. The id comes from the signed cookie
 * (no DB access), `load` starts right away, and `requireUser()` is still awaited first, so a missing or
 * inactive user is redirected before any data is used. `load`'s rejection is observed early (no unhandled
 * rejection when the redirect wins) and re-thrown when the data is awaited.
 * Server actions must not use this: they authorize first, then mutate.
 */
export async function withUser<T>(load: (userId: string) => Promise<T>): Promise<[SessionUser, T]> {
  const userId = await requireSessionUserId();
  const data = load(userId);
  data.catch(() => {});
  const user = await requireUser();
  // The cookie and the row must agree; a mismatch is treated like no session.
  if (user.id !== userId) redirect('/login');
  return [user, await data];
}
