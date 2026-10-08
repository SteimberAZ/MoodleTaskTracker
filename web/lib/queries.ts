/**
 * Pure builders for PostgREST query strings. Every query on per-user tables goes through
 * these helpers so the `user_id` filter cannot be forgotten and the user id is always
 * the one from the verified session (never from form input).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const isUuid = (value: string): boolean => UUID.test(value);

/** Task ids are md5 hex strings; anything outside this alphabet is rejected before it reaches a query. */
export const isSafeId = (value: string): boolean => SAFE_ID.test(value);

function assertUuid(value: string, what: string): void {
  if (!UUID.test(value)) throw new Error(`Invalid ${what}`);
}

/** `user_id=eq.<uuid>` */
export function userFilter(userId: string): string {
  assertUuid(userId, 'user id');
  return `user_id=eq.${userId}`;
}

/** `?user_id=eq.<uuid>&...parts` */
export function scopedQuery(userId: string, ...parts: string[]): string {
  return `?${[userFilter(userId), ...parts.filter(Boolean)].join('&')}`;
}

/** `?id=eq.<id>&user_id=eq.<uuid>`: the only form allowed for single-row reads, updates and deletes. */
export function ownedRowQuery(userId: string, id: string, ...parts: string[]): string {
  assertUuid(id, 'row id');
  return scopedQuery(userId, `id=eq.${id}`, ...parts);
}

/** Task ids are matched exactly and always together with the owner. */
export function ownedTaskQuery(userId: string, taskId: string, ...parts: string[]): string {
  if (!isSafeId(taskId)) throw new Error('Invalid task id');
  return scopedQuery(userId, `id=eq.${taskId}`, ...parts);
}

/** Several tasks by id, owner-scoped. Unsafe ids are dropped. */
export function ownedTasksInQuery(userId: string, ids: string[], ...parts: string[]): string {
  const safe = [...new Set(ids)].filter(isSafeId);
  const list = safe.map((id) => `"${id}"`).join(',');
  return scopedQuery(userId, `id=in.(${encodeURIComponent(list)})`, ...parts);
}

/** `?id=eq.<uuid>&...parts` on `moodle_users`: the row of the session user, never one taken from input. */
export function userRowQuery(userId: string, ...parts: string[]): string {
  assertUuid(userId, 'user id');
  return `?${[`id=eq.${userId}`, ...parts.filter(Boolean)].join('&')}`;
}

export function userByIdentityQuery(moodleUrl: string, siteUserId: number): string {
  if (!Number.isInteger(siteUserId)) throw new Error('Invalid site user id');
  return `moodle_url=eq.${encodeURIComponent(moodleUrl)}&site_userid=eq.${siteUserId}`;
}

/**
 * Atomic claim of an invite: only matches while the code is unused and not expired,
 * so two concurrent logins cannot both consume it.
 */
export function claimInviteQuery(code: string, nowIso: string): string {
  return (
    `code=eq.${encodeURIComponent(code)}&used_at=is.null` +
    `&or=(expires_at.is.null,expires_at.gt.${encodeURIComponent(nowIso)})`
  );
}

/** Releases a claimed invite whose user could not be created (never touches one already tied to a user). */
export function releaseInviteQuery(code: string): string {
  return `code=eq.${encodeURIComponent(code)}&used_by=is.null`;
}

/** Revocation only applies to unused invites. */
export function revokeInviteQuery(code: string): string {
  return `code=eq.${encodeURIComponent(code)}&used_at=is.null`;
}
