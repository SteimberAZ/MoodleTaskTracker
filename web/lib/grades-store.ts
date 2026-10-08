import 'server-only';
import { dbFetch } from './db';
import {
  GRADE_ITEM_COLUMNS,
  gradeItemsPath,
  manualGradesPath,
  parseGradeRows,
  parseManualRows,
  type ExamKind,
  type GradeItemRow,
  type ManualGradeRow,
} from './grades';
import { courseGradeRowsPath, examDeletePath, examUpsert, type ExamInput } from './manual-exams';

export const GRADES_FAILURE = 'No se pudieron cargar tus calificaciones.';
export const EXAM_SAVE_FAILURE = 'No se pudo guardar el examen. Inténtalo de nuevo.';

export type GradesLoad = { state: 'ok'; rows: GradeItemRow[] } | { state: 'missing' } | { state: 'error' };

async function isMissingTable(res: Response): Promise<boolean> {
  let code = '';
  try {
    code = String((JSON.parse(await res.text()) as { code?: unknown })?.code ?? '');
  } catch {
    // Not a PostgREST error body: only the status decides.
  }
  return res.status === 404 || code === 'PGRST205' || code === '42P01';
}

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
    if (await isMissingTable(res)) return { state: 'missing' };
    console.error('Supabase request failed', res.status);
    return { state: 'error' };
  } catch {
    return { state: 'error' };
  }
}

/**
 * The session user's exam entries. `available` is false while moodle_manual_grades does not exist yet (the page
 * then hides the exam forms) or when the read failed; the stats still render from the Moodle rows.
 */
export async function loadManualGrades(userId: string): Promise<{ available: boolean; rows: ManualGradeRow[] }> {
  try {
    const res = await dbFetch(manualGradesPath(userId));
    if (res.ok) {
      const text = await res.text();
      return { available: true, rows: parseManualRows(text ? JSON.parse(text) : []) };
    }
    if (!(await isMissingTable(res))) console.error('Supabase request failed', res.status);
    return { available: false, rows: [] };
  } catch {
    return { available: false, rows: [] };
  }
}

/** One course's stored Moodle rows, used to validate an exam form. Throws on failure. */
export async function loadCourseRows(userId: string, courseId: number): Promise<GradeItemRow[]> {
  const res = await dbFetch(courseGradeRowsPath(userId, courseId, GRADE_ITEM_COLUMNS));
  if (!res.ok) {
    console.error('Supabase request failed', res.status);
    throw new Error(EXAM_SAVE_FAILURE);
  }
  const text = await res.text();
  return parseGradeRows(text ? JSON.parse(text) : []);
}

export async function saveManualGrade(userId: string, input: ExamInput): Promise<void> {
  const { path, headers, body } = examUpsert(userId, input, new Date().toISOString());
  const res = await dbFetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    console.error('Supabase request failed', res.status);
    throw new Error(EXAM_SAVE_FAILURE);
  }
}

export async function deleteManualGrade(userId: string, courseId: number, kind: ExamKind): Promise<void> {
  const res = await dbFetch(examDeletePath(userId, courseId, kind), { method: 'DELETE' });
  if (!res.ok) {
    console.error('Supabase request failed', res.status);
    throw new Error('No se pudo borrar el examen. Inténtalo de nuevo.');
  }
}
