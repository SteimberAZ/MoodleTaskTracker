import 'server-only';
import { dbFetch, dbJson } from './db';
import type { CredentialStatus } from './moodle';

/** Status only: the `token` column is deliberately never selected. */
export async function getCredentialStatus(): Promise<CredentialStatus | null> {
  const rows = await dbJson<CredentialStatus[]>(
    'moodle_credentials?select=moodle_url,username,fullname,site_userid,connected_at,last_error,last_error_at&id=eq.1&limit=1',
  );
  return rows[0] ?? null;
}

export interface CredentialWrite {
  moodle_url: string;
  username: string;
  token: string;
  site_userid: number;
  fullname: string;
}

export async function saveCredentials(data: CredentialWrite): Promise<void> {
  const now = new Date().toISOString();
  const res = await dbFetch('moodle_credentials?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: 1, ...data, connected_at: now, last_error: null, last_error_at: null, updated_at: now }),
  });
  if (!res.ok) {
    // Status only: never log the body or the request, which contain the token.
    console.error('Saving moodle credentials failed', res.status);
    throw new Error('No se pudo guardar la conexión.');
  }
}

export async function deleteCredentials(): Promise<void> {
  const res = await dbFetch('moodle_credentials?id=eq.1', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (!res.ok) {
    console.error('Deleting moodle credentials failed', res.status);
    throw new Error('No se pudo desconectar.');
  }
}
