import { DEFAULT_EXAM_POINTS, isExamKind, type ExamKind, type GradeItemRow } from './grades';
import { scopedQuery, userFilter } from './queries';

/** Pure parsing, validation and query building for the student's exam entries (moodle_manual_grades). */

export const MANUAL_TABLE = 'moodle_manual_grades';

/** What the student asked to save; every field is validated, the owner never comes from the form. */
export interface ExamInput {
  courseId: number;
  kind: ExamKind;
  grade: number | null;
  maxPoints: number;
  linkedItemId: number | null;
}

export type ExamParse = { ok: true; value: ExamInput } | { ok: false; error: string };

const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

/** Accepts "12", "12.5" and "12,5"; anything else is null. */
export function parsePoints(text: string): number | null {
  const normalized = text.replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(normalized)) return null;
  return Number(normalized);
}

export function parseCourseAndKind(form: FormData): { courseId: number; kind: ExamKind } | null {
  const course = field(form, 'course_id');
  const kind = field(form, 'kind');
  if (!/^\d{1,9}$/.test(course) || !isExamKind(kind)) return null;
  return { courseId: Number(course), kind };
}

/**
 * Validates the exam form against the course's stored Moodle rows (`courseRows`, already scoped to the session
 * user): the course must be one of the user's courses and a link must point to one of its activities.
 * `no_exam=1` saves "this course has no such exam".
 */
export function parseExamForm(form: FormData, courseRows: GradeItemRow[]): ExamParse {
  const target = parseCourseAndKind(form);
  if (!target) return { ok: false, error: 'Datos del examen no válidos.' };
  if (!courseRows.some((r) => r.course_id === target.courseId)) {
    return { ok: false, error: 'No encontramos esa materia en tus calificaciones.' };
  }

  if (field(form, 'no_exam') === '1') {
    return { ok: true, value: { ...target, grade: null, maxPoints: DEFAULT_EXAM_POINTS, linkedItemId: null } };
  }

  const maxText = field(form, 'max_points');
  const maxPoints = maxText === '' ? DEFAULT_EXAM_POINTS : parsePoints(maxText);
  if (maxPoints === null || maxPoints <= 0 || maxPoints > 100) {
    return { ok: false, error: 'El examen debe valer entre 0,01 y 100 puntos.' };
  }

  const gradeText = field(form, 'grade');
  const grade = gradeText === '' ? null : parsePoints(gradeText);
  if (gradeText !== '' && grade === null) return { ok: false, error: 'Escribe la nota con números, por ejemplo 12,5.' };
  if (grade !== null && grade > maxPoints) {
    return { ok: false, error: `La nota no puede ser mayor que ${String(maxPoints).replace('.', ',')}.` };
  }

  const linkText = field(form, 'linked_item_id');
  let linkedItemId: number | null = null;
  if (linkText !== '') {
    const id = /^\d{1,9}$/.test(linkText) ? Number(linkText) : NaN;
    const leaf = courseRows.find(
      (r) => r.course_id === target.courseId && r.item_id === id && (r.item_type === 'mod' || r.item_type === 'manual'),
    );
    if (!leaf) return { ok: false, error: 'Esa actividad no es de esta materia.' };
    linkedItemId = leaf.item_id;
  }

  if (grade === null && linkedItemId === null) {
    return { ok: false, error: 'Escribe tu nota o elige la actividad de Moodle que corresponde al examen.' };
  }
  return { ok: true, value: { ...target, grade, maxPoints, linkedItemId } };
}

/** Upsert of one exam entry, keyed by (user, course, kind). */
export function examUpsert(userId: string, input: ExamInput, nowIso: string) {
  userFilter(userId); // throws unless it is a UUID
  return {
    path: `${MANUAL_TABLE}?on_conflict=user_id,course_id,kind`,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: {
      user_id: userId,
      course_id: input.courseId,
      kind: input.kind,
      grade: input.grade,
      max_points: input.maxPoints,
      linked_item_id: input.linkedItemId,
      updated_at: nowIso,
    },
  };
}

export function examDeletePath(userId: string, courseId: number, kind: ExamKind): string {
  if (!Number.isInteger(courseId) || courseId < 0 || !isExamKind(kind)) throw new Error('Invalid exam');
  return `${MANUAL_TABLE}${scopedQuery(userId, `course_id=eq.${courseId}`, `kind=eq.${kind}`)}`;
}

export function courseGradeRowsPath(userId: string, courseId: number, columns: string): string {
  if (!Number.isInteger(courseId) || courseId < 0) throw new Error('Invalid course');
  return `moodle_grade_items${scopedQuery(userId, `course_id=eq.${courseId}`, `select=${columns}`, 'limit=500')}`;
}
