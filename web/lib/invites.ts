import 'server-only';
import { dbFetch, dbJson } from './db';
import { revokeInviteQuery } from './queries';
import { generateInviteCode } from './random';

export interface Invite {
  code: string;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  used_at: string | null;
  used_by: string | null;
}

const COLUMNS = 'code,created_by,created_at,expires_at,used_at,used_by';
const MAX_ATTEMPTS = 5;

export function listInvites(): Promise<Invite[]> {
  return dbJson<Invite[]>(
    `moodle_invites?select=${COLUMNS}&order=created_at.desc&limit=200`,
    {},
    'No se pudieron cargar las invitaciones.',
  );
}

/** Creates an invite; retries on the (astronomically unlikely) code collision. */
export async function createInvite(createdBy: string, expiresAt: Date | null): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateInviteCode();
    const res = await dbFetch('moodle_invites?select=code', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ code, created_by: createdBy, expires_at: expiresAt ? expiresAt.toISOString() : null }),
    });
    if (res.status === 409) continue;
    if (!res.ok) {
      console.error('Creating invite failed', res.status);
      throw new Error('No se pudo crear la invitación.');
    }
    return code;
  }
  throw new Error('No se pudo crear la invitación.');
}

/** Only unused invites can be revoked; a used one is history. */
export async function revokeInvite(code: string): Promise<void> {
  await dbJson<unknown>(
    `moodle_invites?${revokeInviteQuery(code)}`,
    { method: 'DELETE', headers: { Prefer: 'return=minimal' } },
    'No se pudo revocar la invitación.',
  );
}
