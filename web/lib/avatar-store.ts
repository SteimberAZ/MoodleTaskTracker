import 'server-only';
import { dbFetch } from './db';
import { avatarDeletePath, avatarReadPath, avatarUpsert } from './avatar';

export const AVATAR_SAVE_FAILURE = 'No se pudo guardar la foto. Inténtalo de nuevo.';

/** The session user's photo as a data URL, or null (none yet, table missing or any failure). Never throws. */
export async function loadAvatar(userId: string): Promise<string | null> {
  try {
    const res = await dbFetch(avatarReadPath(userId));
    if (!res.ok) return null;
    const text = await res.text();
    const rows = (text ? JSON.parse(text) : []) as { image?: unknown }[];
    return Array.isArray(rows) && typeof rows[0]?.image === 'string' ? rows[0].image : null;
  } catch {
    return null;
  }
}

export async function saveAvatar(userId: string, dataUrl: string): Promise<void> {
  const { path, headers, body } = avatarUpsert(userId, dataUrl, new Date().toISOString());
  const res = await dbFetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    console.error('Supabase request failed', res.status);
    throw new Error(AVATAR_SAVE_FAILURE);
  }
}

export async function deleteAvatar(userId: string): Promise<void> {
  const res = await dbFetch(avatarDeletePath(userId), { method: 'DELETE' });
  if (!res.ok) {
    console.error('Supabase request failed', res.status);
    throw new Error('No se pudo quitar la foto. Inténtalo de nuevo.');
  }
}
