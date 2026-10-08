import { describe, expect, it, vi } from 'vitest';
import type { ExamEntry, GradeItemRow } from '@/lib/grades';
import { examDeletePath, examUpsert, parseExamForm, parsePoints } from '@/lib/manual-exams';
import { examSummary } from '@/components/ExamEntry';

vi.mock('@/app/estadisticas/actions', () => ({ saveExam: vi.fn(), deleteExam: vi.fn() }));

const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';

const leaf = (item_id: number, item_type = 'mod'): GradeItemRow => ({
  course_id: 10,
  item_id,
  course_name: 'Física',
  item_name: `Item ${item_id}`,
  item_type,
  item_module: null,
  cmid: null,
  item_instance: null,
  category_id: null,
  sort_order: 0,
  report_depth: 2,
  grade_raw: null,
  grade_min: 0,
  grade_max: 20,
  grade_formatted: null,
  percentage_formatted: null,
  weight_raw: null,
  graded_at: null,
  fetched_at: null,
});
const ROWS = [leaf(500, 'course'), leaf(501), leaf(502)];

const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ course_id: '10', kind: 'midterm', ...fields })) f.set(k, v);
  return f;
};

describe('parsePoints', () => {
  it('accepts a comma or a dot and at most two decimals', () => {
    expect(parsePoints('12')).toBe(12);
    expect(parsePoints('12,5')).toBe(12.5);
    expect(parsePoints('12.75')).toBe(12.75);
    for (const bad of ['', '-1', '1e2', '12,555', 'doce', '1000']) expect(parsePoints(bad)).toBeNull();
  });
});

describe('parseExamForm', () => {
  it('saves a grade out of 15 by default', () => {
    expect(parseExamForm(form({ grade: '12,5', max_points: '' }), ROWS)).toEqual({
      ok: true,
      value: { courseId: 10, kind: 'midterm', grade: 12.5, maxPoints: 15, linkedItemId: null },
    });
  });

  it('links the exam only to an activity of the same course', () => {
    expect(parseExamForm(form({ grade: '10', linked_item_id: '502' }), ROWS)).toMatchObject({
      ok: true,
      value: { linkedItemId: 502 },
    });
    expect(parseExamForm(form({ grade: '10', linked_item_id: '500' }), ROWS)).toMatchObject({ ok: false });
    expect(parseExamForm(form({ grade: '10', linked_item_id: '999' }), ROWS)).toMatchObject({ ok: false });
  });

  it('a link without a grade says "this exam is that Moodle activity"', () => {
    expect(parseExamForm(form({ grade: '', linked_item_id: '501' }), ROWS)).toMatchObject({
      ok: true,
      value: { grade: null, linkedItemId: 501 },
    });
  });

  it('marks a course without that exam', () => {
    expect(parseExamForm(form({ no_exam: '1', grade: 'whatever' }), ROWS)).toEqual({
      ok: true,
      value: { courseId: 10, kind: 'midterm', grade: null, maxPoints: 15, linkedItemId: null },
    });
  });

  it('rejects bad input', () => {
    const cases: Record<string, string>[] = [
      { grade: '16' },
      { grade: 'abc' },
      { grade: '5', max_points: '0' },
      { grade: '5', max_points: '101' },
      { grade: '' },
      { grade: '5', kind: 'quiz' },
      { grade: '5', course_id: 'x' },
    ];
    for (const c of cases) expect(parseExamForm(form(c), ROWS).ok).toBe(false);
    // A course the user has no grade rows for.
    expect(parseExamForm(form({ grade: '5', course_id: '11' }), ROWS).ok).toBe(false);
  });
});

describe('exam queries', () => {
  it('upserts by user, course and kind with the session user as owner', () => {
    const q = examUpsert(USER, { courseId: 10, kind: 'final', grade: 9, maxPoints: 15, linkedItemId: null }, 'T');
    expect(q.path).toBe('moodle_manual_grades?on_conflict=user_id,course_id,kind');
    expect(q.body).toEqual({
      user_id: USER,
      course_id: 10,
      kind: 'final',
      grade: 9,
      max_points: 15,
      linked_item_id: null,
      updated_at: 'T',
    });
    expect(() => examUpsert('not-a-uuid', { courseId: 1, kind: 'final', grade: 1, maxPoints: 15, linkedItemId: null }, 'T')).toThrow();
  });

  it('deletes only the user own entry', () => {
    expect(examDeletePath(USER, 10, 'midterm')).toBe(`moodle_manual_grades?user_id=eq.${USER}&course_id=eq.10&kind=eq.midterm`);
    expect(() => examDeletePath(USER, -1, 'midterm')).toThrow();
  });
});

describe('examSummary', () => {
  const exam = (o: Partial<ExamEntry>): ExamEntry => ({
    kind: 'midterm',
    label: 'Examen de medio ciclo',
    state: 'missing',
    grade: null,
    maxPoints: 15,
    linkedItemId: null,
    linkedItemName: null,
    ...o,
  });
  it('asks while missing and describes every other state', () => {
    expect(examSummary(exam({}))).toBe('¿Ya diste tu examen de medio ciclo? Agrégalo');
    expect(examSummary(exam({ kind: 'final', label: 'Examen de fin de ciclo' }))).toBe('¿Ya diste tu examen de fin de ciclo? Agrégalo');
    expect(examSummary(exam({ state: 'manual', grade: 12.5 }))).toBe('Examen de medio ciclo: 12,5/15 (nota tuya)');
    expect(examSummary(exam({ state: 'moodle' }))).toBe('Examen de medio ciclo: Moodle ya tiene la nota');
    expect(examSummary(exam({ state: 'linked', linkedItemName: 'Parcial 1' }))).toBe(
      'Examen de medio ciclo: en Moodle como «Parcial 1», sin nota todavía',
    );
    expect(examSummary(exam({ state: 'none' }))).toBe('Examen de medio ciclo: esta materia no lo tiene');
  });
});
