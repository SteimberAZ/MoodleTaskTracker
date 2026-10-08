import 'server-only';
import { dbFetchAnonymous } from './db';
import { claimInviteQuery, releaseInviteQuery, userByIdentityQuery } from './queries';
import { generateNtfyTopic } from './random';
import type { CreateUserResult, LoginDeps, LoginUpdate, LoginUser, NewUserData } from './login-flow';

/**
 * Database side of the login flow. It runs before a session exists, hence the anonymous
 * database access. Failures log the HTTP status only: request and response bodies carry
 * Moodle tokens and ntfy topics.
 */
const JSON_RETURN = { Prefer: 'return=representation' };
const MINIMAL = { Prefer: 'return=minimal' };
const LOGIN_COLUMNS = 'id,is_admin,active';

function fail(what: string, res: Response): never {
  console.error(`${what} failed`, res.status);
  throw new Error(what);
}

async function findUser(moodleUrl: string, siteUserId: number): Promise<LoginUser | null> {
  const res = await dbFetchAnonymous(
    `moodle_users?select=${LOGIN_COLUMNS}&${userByIdentityQuery(moodleUrl, siteUserId)}&limit=1`,
  );
  if (!res.ok) fail('Looking up user', res);
  const rows = (await res.json()) as LoginUser[];
  return rows[0] ?? null;
}

async function adminExists(): Promise<boolean> {
  const res = await dbFetchAnonymous('moodle_users?select=id&is_admin=eq.true&limit=1');
  if (!res.ok) fail('Looking up admin', res);
  return ((await res.json()) as unknown[]).length > 0;
}

async function createUser(data: NewUserData): Promise<CreateUserResult> {
  // `select` limits the returned columns so the token never comes back.
  const res = await dbFetchAnonymous(`moodle_users?select=${LOGIN_COLUMNS}`, {
    method: 'POST',
    headers: JSON_RETURN,
    body: JSON.stringify(data),
  });
  if (res.status === 409) return { kind: 'conflict' };
  if (!res.ok) fail('Creating user', res);
  const rows = (await res.json()) as LoginUser[];
  if (!rows[0]) throw new Error('Creating user returned no row');
  return { kind: 'created', user: rows[0] };
}

async function updateLogin(userId: string, update: LoginUpdate): Promise<void> {
  const body: Record<string, unknown> = {
    token: update.token,
    username: update.username,
    last_login_at: update.nowIso,
    last_error: null,
    last_error_at: null,
    updated_at: update.nowIso,
  };
  if (update.fullname) body.fullname = update.fullname;
  const res = await dbFetchAnonymous(`moodle_users?id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: MINIMAL,
    body: JSON.stringify(body),
  });
  if (!res.ok) fail('Updating user', res);
}

async function claimInvite(code: string, nowIso: string): Promise<boolean> {
  const res = await dbFetchAnonymous(`moodle_invites?${claimInviteQuery(code, nowIso)}&select=code`, {
    method: 'PATCH',
    headers: JSON_RETURN,
    body: JSON.stringify({ used_at: nowIso }),
  });
  if (!res.ok) fail('Claiming invite', res);
  return ((await res.json()) as unknown[]).length > 0;
}

async function releaseInvite(code: string): Promise<void> {
  try {
    const res = await dbFetchAnonymous(`moodle_invites?${releaseInviteQuery(code)}`, {
      method: 'PATCH',
      headers: MINIMAL,
      body: JSON.stringify({ used_at: null }),
    });
    if (!res.ok) console.error('Releasing invite failed', res.status);
  } catch {
    console.error('Releasing invite failed');
  }
}

async function markInviteUsed(code: string, userId: string): Promise<void> {
  try {
    const res = await dbFetchAnonymous(`moodle_invites?code=eq.${encodeURIComponent(code)}`, {
      method: 'PATCH',
      headers: MINIMAL,
      body: JSON.stringify({ used_by: userId }),
    });
    if (!res.ok) console.error('Recording invite user failed', res.status);
  } catch {
    console.error('Recording invite user failed');
  }
}

async function claimOrphanReminders(userId: string): Promise<void> {
  try {
    const res = await dbFetchAnonymous('moodle_custom_reminders?user_id=is.null', {
      method: 'PATCH',
      headers: MINIMAL,
      body: JSON.stringify({ user_id: userId }),
    });
    if (!res.ok) console.error('Claiming orphan reminders failed', res.status);
  } catch {
    console.error('Claiming orphan reminders failed');
  }
}

export const loginStore: LoginDeps = {
  now: () => new Date(),
  randomTopic: () => generateNtfyTopic(),
  findUser,
  adminExists,
  createUser,
  updateLogin,
  claimInvite,
  releaseInvite,
  markInviteUsed,
  claimOrphanReminders,
};
