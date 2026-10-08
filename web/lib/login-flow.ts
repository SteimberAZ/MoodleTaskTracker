import type { MoodleConnection } from './moodle';
import { isValidTopic, normalizeInviteCode } from './random';

/**
 * Pure login decision logic. All I/O is injected through `LoginDeps`, so every branch
 * (existing user, inactive, admin bootstrap, invite required, invite accepted, races)
 * is unit-testable without a database or Moodle.
 */
export const ERR_INACTIVE = 'Tu cuenta está desactivada';
export const ERR_NEEDS_INVITE = 'Necesitas un código de invitación para crear tu cuenta';
export const ERR_INVITE = 'Código de invitación inválido o ya usado';
export const ERR_ADMIN_TOPIC = 'La configuración del tema del administrador no es válida.';
export const ERR_CREATE = 'No se pudo crear tu cuenta. Inténtalo de nuevo.';

export interface LoginUser {
  id: string;
  is_admin: boolean;
  active: boolean;
}

export interface NewUserData {
  moodle_url: string;
  site_userid: number;
  username: string;
  fullname: string | null;
  token: string;
  ntfy_topic: string;
  is_admin: boolean;
}

export interface LoginUpdate {
  token: string;
  fullname?: string;
  username: string;
  nowIso: string;
}

export type CreateUserResult = { kind: 'created'; user: LoginUser } | { kind: 'conflict' };

export interface LoginDeps {
  now(): Date;
  randomTopic(): string;
  findUser(moodleUrl: string, siteUserId: number): Promise<LoginUser | null>;
  adminExists(): Promise<boolean>;
  /** Returns `conflict` on a unique violation; throws on any other failure. */
  createUser(data: NewUserData): Promise<CreateUserResult>;
  /** Refreshes token/name and clears the last error. Throws on failure. */
  updateLogin(userId: string, update: LoginUpdate): Promise<void>;
  /** Atomically consumes an unused, unexpired invite. False when no row matched. Throws on failure. */
  claimInvite(code: string, nowIso: string): Promise<boolean>;
  /** Best-effort: must not throw. */
  releaseInvite(code: string): Promise<void>;
  /** Best-effort: must not throw. */
  markInviteUsed(code: string, userId: string): Promise<void>;
  /** Best-effort: must not throw. Assigns ownerless reminders to the admin. */
  claimOrphanReminders(userId: string): Promise<void>;
}

export interface LoginRequest {
  moodleUrl: string;
  connection: MoodleConnection;
  /** Username as typed (trimmed). */
  username: string;
  /** Invite code as typed; may be empty. */
  inviteCode: string;
  adminUsername?: string;
  adminTopic?: string;
}

export type LoginOutcome =
  | { ok: true; userId: string; created: boolean; isAdmin: boolean }
  | { ok: false; error: string };

const fail = (error: string): LoginOutcome => ({ ok: false, error });

export const isBootstrapAdminName = (username: string, adminUsername: string | undefined): boolean => {
  const admin = (adminUsername ?? '').trim().toLowerCase();
  return admin !== '' && username.trim().toLowerCase() === admin;
};

export async function decideLogin(deps: LoginDeps, req: LoginRequest): Promise<LoginOutcome> {
  const { moodleUrl, connection } = req;
  const adminCandidate = isBootstrapAdminName(req.username, req.adminUsername);

  async function loginExisting(user: LoginUser): Promise<LoginOutcome> {
    if (!user.active) return fail(ERR_INACTIVE);
    await deps.updateLogin(user.id, {
      token: connection.token,
      fullname: connection.fullname || undefined,
      username: req.username,
      nowIso: deps.now().toISOString(),
    });
    // Idempotent and cheap: lets the bootstrap admin recover orphans if an earlier claim failed.
    if (user.is_admin && adminCandidate) await deps.claimOrphanReminders(user.id);
    return { ok: true, userId: user.id, created: false, isAdmin: user.is_admin };
  }

  const baseData = (topic: string, isAdmin: boolean): NewUserData => ({
    moodle_url: moodleUrl,
    site_userid: connection.siteUserId,
    username: req.username,
    fullname: connection.fullname || null,
    token: connection.token,
    ntfy_topic: topic,
    is_admin: isAdmin,
  });

  const existing = await deps.findUser(moodleUrl, connection.siteUserId);
  if (existing) return loginExisting(existing);

  // Admin bootstrap: the configured Moodle username registers without an invite, once.
  if (adminCandidate && !(await deps.adminExists())) {
    const configured = (req.adminTopic ?? '').trim();
    if (configured && !isValidTopic(configured)) return fail(ERR_ADMIN_TOPIC);
    const created = await deps.createUser(baseData(configured || deps.randomTopic(), true));
    if (created.kind === 'created') {
      await deps.claimOrphanReminders(created.user.id);
      return { ok: true, userId: created.user.id, created: true, isAdmin: true };
    }
    const raced = await deps.findUser(moodleUrl, connection.siteUserId);
    return raced ? loginExisting(raced) : fail(ERR_CREATE);
  }

  // Everyone else needs a single-use invite, claimed before the user row is created.
  if (!req.inviteCode.trim()) return fail(ERR_NEEDS_INVITE);
  const code = normalizeInviteCode(req.inviteCode);
  if (!code) return fail(ERR_INVITE);
  if (!(await deps.claimInvite(code, deps.now().toISOString()))) return fail(ERR_INVITE);

  let created: CreateUserResult;
  try {
    created = await deps.createUser(baseData(deps.randomTopic(), false));
  } catch (error) {
    await deps.releaseInvite(code);
    throw error;
  }

  if (created.kind === 'created') {
    await deps.markInviteUsed(code, created.user.id);
    return { ok: true, userId: created.user.id, created: true, isAdmin: false };
  }

  // Lost a race on (moodle_url, site_userid): the person already exists, so the invite is not spent.
  await deps.releaseInvite(code);
  const raced = await deps.findUser(moodleUrl, connection.siteUserId);
  return raced ? loginExisting(raced) : fail(ERR_CREATE);
}
