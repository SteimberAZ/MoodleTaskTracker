import 'server-only';
import { dbFetch } from './db';
import { gradeItemsPath, parseGradeRows, type GradeItemRow } from './grades';

export const GRADES_FAILURE = 'No se pudieron cargar tus calificaciones.';

export type GradesLoad = { state: 'ok'; rows: GradeItemRow[] } | { state: 'missing' } | { state: 'error' };

/**
 * The session user's grade items. Never throws: 'missing' when moodle_grade_items does not exist yet
 * (404 / PGRST205 / 42P01), 'error' on any other failure. Response bodies are never logged.
 */
export async function loadGrades(userId: string): Promise<GradesLoad> {
  try {
    const res = await dbFetch(gradeItemsPath(userId));
    if (res.ok) {
      const text = await res.text();
      return { state: 'ok', rows: parseGradeRows(text ? JSON.parse(text) : []) };
    }
    let code = '';
    try {
      code = String((JSON.parse(await res.text()) as { code?: unknown })?.code ?? '');
    } catch {
      // Not a PostgREST error body: only the status decides.
    }
    if (res.status === 404 || code === 'PGRST205' || code === '42P01') return { state: 'missing' };
    console.error('Supabase request failed', res.status);
    return { state: 'error' };
  } catch {
    return { state: 'error' };
  }
}
