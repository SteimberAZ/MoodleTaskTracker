import { describe, expect, it } from 'vitest';
import {
  buildStandings,
  computeCourseStanding,
  formatPoints,
  gradeItemsPath,
  latestFetch,
  manualGradesPath,
  parseGradeRows,
  parseManualRows,
  round2,
  summarizeStandings,
  type GradeItemRow,
  type ManualGradeRow,
} from '@/lib/grades';

const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';

const base: Omit<GradeItemRow, 'course_id' | 'item_id' | 'item_type'> = {
  course_name: 'Física',
  item_name: null,
  item_module: null,
  cmid: null,
  item_instance: null,
  category_id: 31,
  sort_order: 0,
  report_depth: 2,
  grade_raw: null,
  grade_min: 0,
  grade_max: 100,
  grade_formatted: null,
  percentage_formatted: null,
  weight_raw: null,
  graded_at: null,
  fetched_at: '2026-10-08T15:00:00+00:00',
};
const row = (o: Partial<GradeItemRow> & Pick<GradeItemRow, 'course_id' | 'item_id' | 'item_type'>): GradeItemRow => ({
  ...base,
  ...o,
});

// A: flat weights, on track
const A = [
  row({ course_id: 10, item_id: 500, item_type: 'course', item_instance: 31, category_id: null, sort_order: 3, grade_raw: 17 }),
  row({ course_id: 10, item_id: 501, item_type: 'mod', item_name: 'Tarea 1', item_module: 'assign', sort_order: 0, weight_raw: 0.2, grade_raw: 17, grade_max: 20, graded_at: 1799950000 }),
  row({ course_id: 10, item_id: 502, item_type: 'mod', item_name: 'Examen parcial', item_module: 'quiz', sort_order: 1, weight_raw: 0.3, grade_max: 30 }),
  row({ course_id: 10, item_id: 503, item_type: 'mod', item_name: 'Proyecto final', sort_order: 2, weight_raw: 0.5, grade_max: 50 }),
];
// B: renormalized weights -> points, at risk
const B = [
  row({ course_id: 11, course_name: 'Química', item_id: 600, item_type: 'course', item_instance: 41, category_id: null, grade_raw: 34, grade_max: 50 }),
  row({ course_id: 11, course_name: 'Química', item_id: 601, item_type: 'mod', item_name: 'P1', category_id: 41, grade_max: 25, grade_raw: 20, weight_raw: 0.5, graded_at: 1799000000, sort_order: 1 }),
  row({ course_id: 11, course_name: 'Química', item_id: 602, item_type: 'mod', item_name: 'P2', category_id: 41, grade_max: 25, grade_raw: 14, weight_raw: 0.5, graded_at: 1799500000, sort_order: 2 }),
  row({ course_id: 11, course_name: 'Química', item_id: 603, item_type: 'mod', item_name: 'Final', category_id: 41, grade_max: 50, sort_order: 3 }),
];
// C: points, 70 unreachable
const C = [
  row({ course_id: 12, course_name: 'Cálculo', item_id: 700, item_type: 'course', grade_raw: 20 }),
  row({ course_id: 12, course_name: 'Cálculo', item_id: 701, item_type: 'mod', grade_max: 40, grade_raw: 10, graded_at: 1 }),
  row({ course_id: 12, course_name: 'Cálculo', item_id: 702, item_type: 'mod', grade_max: 40, grade_raw: 10, graded_at: 2 }),
  row({ course_id: 12, course_name: 'Cálculo', item_id: 703, item_type: 'mod', grade_max: 20 }),
];
// D: weights, passed
const D = [
  row({ course_id: 13, course_name: 'Arte', item_id: 800, item_type: 'course', item_instance: 31, category_id: null, grade_raw: 85 }),
  row({ course_id: 13, course_name: 'Arte', item_id: 801, item_type: 'manual', weight_raw: 0.5, grade_raw: 45, grade_max: 50 }),
  row({ course_id: 13, course_name: 'Arte', item_id: 802, item_type: 'mod', weight_raw: 0.5, grade_raw: 40, grade_max: 50 }),
];
// E: estimate from the course total
const E = [
  row({ course_id: 14, course_name: 'Bio', item_id: 900, item_type: 'course', grade_raw: 8, grade_max: 20 }),
  // Maxima add up to 120, so they are not direct points and the weights are missing.
  row({ course_id: 14, course_name: 'Bio', item_id: 901, item_type: 'mod', grade_max: 60, grade_raw: 8 }),
  row({ course_id: 14, course_name: 'Bio', item_id: 902, item_type: 'mod', grade_max: 60 }),
];
// F: nothing graded yet
const F = [
  row({ course_id: 15, course_name: 'Ética', item_id: 1000, item_type: 'course', item_instance: 31, category_id: null }),
  row({ course_id: 15, course_name: 'Ética', item_id: 1001, item_type: 'mod', weight_raw: 0.4, grade_max: 40 }),
  row({ course_id: 15, course_name: 'Ética', item_id: 1002, item_type: 'mod', weight_raw: 0.6, grade_max: 60 }),
];
// G: one category level (depth 3)
const G = [
  row({ course_id: 16, course_name: 'Historia', item_id: 1100, item_type: 'course', item_instance: 51, category_id: null, report_depth: 3 }),
  row({ course_id: 16, course_name: 'Historia', item_id: 1110, item_type: 'category', item_instance: 52, category_id: null, weight_raw: 0.6, report_depth: 3 }),
  row({ course_id: 16, course_name: 'Historia', item_id: 1111, item_type: 'mod', category_id: 52, weight_raw: 0.5, grade_raw: 10, grade_max: 10, report_depth: 3 }),
  row({ course_id: 16, course_name: 'Historia', item_id: 1112, item_type: 'mod', category_id: 52, weight_raw: 0.5, grade_max: 10, report_depth: 3 }),
  row({ course_id: 16, course_name: 'Historia', item_id: 1113, item_type: 'mod', category_id: 51, weight_raw: 0.4, grade_max: 100, report_depth: 3 }),
];

describe('computeCourseStanding', () => {
  it('counts each activity as its share of the 100 points (A)', () => {
    const s = computeCourseStanding(A);
    expect(s).toMatchObject({
      courseId: 10,
      method: 'points',
      estimate: false,
      earned: 17,
      spent: 20,
      available: 80,
      needed: 53,
      maxReachable: 97,
      reachable: true,
      passed: false,
      neededShare: 0.6625,
      status: 'on_track',
      pendingItems: 2,
      graded: [{ itemId: 501, name: 'Tarea 1', grade: 17, max: 20, contribution: 17, gradedAt: 1799950000 }],
    });
    expect(s.fetchedAt).toBe('2026-10-08T15:00:00+00:00');
  });

  it('falls back to points when the weights were renormalized (B)', () => {
    const s = computeCourseStanding(B);
    expect(s).toMatchObject({
      method: 'points',
      earned: 34,
      spent: 50,
      available: 50,
      needed: 36,
      maxReachable: 84,
      neededShare: 0.72,
      status: 'at_risk',
    });
    expect(s.graded.map((g) => g.itemId)).toEqual([602, 601]);
    expect(s.graded.map((g) => g.contribution)).toEqual([14, 20]);
  });

  it('flags a course whose 70 can no longer be reached (C)', () => {
    expect(computeCourseStanding(C)).toMatchObject({
      method: 'points',
      earned: 20,
      spent: 80,
      available: 20,
      maxReachable: 40,
      reachable: false,
      needed: 50,
      status: 'lost',
    });
  });

  it('marks a course with 70 or more as passed (D)', () => {
    expect(computeCourseStanding(D)).toMatchObject({
      method: 'points',
      earned: 85,
      spent: 100,
      available: 0,
      needed: 0,
      passed: true,
      neededShare: null,
      status: 'passed',
    });
  });

  it('estimates from the course total when nothing better is available (E)', () => {
    const s = computeCourseStanding(E);
    expect(s).toMatchObject({
      method: 'estimate',
      estimate: true,
      earned: 40,
      spent: null,
      available: null,
      maxReachable: null,
      reachable: null,
      neededShare: null,
      needed: 30,
      status: 'unknown',
    });
    expect(s.graded[0].contribution).toBeNull();
  });

  it('reports no_grades while nothing is graded (F)', () => {
    expect(computeCourseStanding(F)).toMatchObject({
      method: 'points',
      earned: 0,
      spent: 0,
      available: 100,
      needed: 70,
      status: 'no_grades',
      pendingItems: 2,
    });
  });

  it('multiplies the category weight into the item weight (G)', () => {
    const s = computeCourseStanding(G);
    expect(s).toMatchObject({
      method: 'weights',
      earned: 30,
      spent: 30,
      available: 70,
      needed: 40,
      maxReachable: 100,
      status: 'on_track',
    });
    expect(s.neededShare).toBeCloseTo(0.5714, 3);
  });

  it('skips the weights beyond one category level and estimates instead', () => {
    const deep = G.map((r) => ({ ...r, report_depth: 4, grade_raw: r.item_type === 'course' ? 30 : r.grade_raw }));
    expect(computeCourseStanding(deep)).toMatchObject({ method: 'estimate', earned: 30 });
  });

  it('skips the renormalized weights when an ungraded item has a zero weight', () => {
    const rows = [
      row({ course_id: 20, item_id: 1, item_type: 'course', item_instance: 31, category_id: null }),
      row({ course_id: 20, item_id: 2, item_type: 'mod', weight_raw: 1, grade_raw: 8, grade_max: 10, graded_at: 5 }),
      row({ course_id: 20, item_id: 3, item_type: 'mod', weight_raw: 0, grade_max: 10 }),
    ];
    // Maxima add up to 20: direct points apply, the weights are not used.
    expect(computeCourseStanding(rows)).toMatchObject({ method: 'points', earned: 8, spent: 10, available: 90, status: 'on_track' });
  });

  it('does not mark an estimate as passed while activities are still pending (renormalized course total)', () => {
    // Moodle renormalizes the course total over the graded items: 9/10 graded, the rest open, total shown 90/100.
    const rows = [
      row({ course_id: 21, item_id: 1, item_type: 'course', item_instance: 31, category_id: null, grade_raw: 90, grade_max: 100 }),
      row({ course_id: 21, item_id: 2, item_type: 'mod', weight_raw: 1, grade_raw: 9, grade_max: 10, graded_at: 5 }),
      // Maxima add up to 130: not direct points, so the course total is the estimate.
      row({ course_id: 21, item_id: 3, item_type: 'mod', weight_raw: 0, grade_max: 60 }),
      row({ course_id: 21, item_id: 4, item_type: 'mod', weight_raw: 0, grade_max: 60 }),
    ];
    const s = computeCourseStanding(rows);
    expect(s).toMatchObject({
      method: 'estimate',
      estimate: true,
      earned: 90,
      needed: 0,
      passed: false,
      status: 'unknown',
      pendingItems: 2,
    });
    expect(summarizeStandings([s])).toMatchObject({ passed: 0, noData: 1 });
  });

  it('allows an estimate to pass once nothing is pending', () => {
    const rows = [
      row({ course_id: 22, item_id: 1, item_type: 'course', item_instance: 31, category_id: null, grade_raw: 90, grade_max: 100 }),
      // Weights add up to 0.7 and the maxima to 120, so neither the weights nor the direct points method applies.
      row({ course_id: 22, item_id: 2, item_type: 'mod', weight_raw: 0.5, grade_raw: 9, grade_max: 60, graded_at: 5 }),
      row({ course_id: 22, item_id: 3, item_type: 'mod', weight_raw: 0.2, grade_raw: 9, grade_max: 60, graded_at: 6 }),
    ];
    expect(computeCourseStanding(rows)).toMatchObject({ method: 'estimate', passed: true, status: 'passed', pendingItems: 0 });
  });

  it('does not use the weights when a leaf points at an unknown category', () => {
    const rows = A.map((r) => (r.item_id === 502 ? { ...r, category_id: 99 } : r));
    expect(computeCourseStanding(rows).method).not.toBe('weights');
  });
});

describe('buildStandings and summarizeStandings', () => {
  const list = buildStandings([...D, ...A, ...F, ...C, ...B, ...E]);

  it('orders the courses needing attention first', () => {
    expect(list.map((s) => s.courseId)).toEqual([12, 11, 10, 14, 15, 13]);
    expect(list.map((s) => s.status)).toEqual(['lost', 'at_risk', 'on_track', 'unknown', 'no_grades', 'passed']);
  });

  it('counts the statuses', () => {
    expect(summarizeStandings(list)).toEqual({ total: 6, passed: 1, onTrack: 1, atRisk: 2, noData: 2 });
  });
});

describe('latestFetch', () => {
  it('picks the newest fetched_at', () => {
    const rows = [
      row({ course_id: 1, item_id: 1, item_type: 'mod', fetched_at: '2026-10-08T10:00:00+00:00' }),
      row({ course_id: 1, item_id: 2, item_type: 'mod', fetched_at: '2026-10-09T10:00:00+00:00' }),
      row({ course_id: 1, item_id: 3, item_type: 'mod', fetched_at: 'not a date' }),
      row({ course_id: 1, item_id: 4, item_type: 'mod', fetched_at: null }),
    ];
    expect(latestFetch(rows)).toBe('2026-10-09T10:00:00+00:00');
  });

  it('is null without rows', () => {
    expect(latestFetch([])).toBeNull();
  });
});

describe('number helpers', () => {
  it('rounds to two decimals', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(66.249)).toBe(66.25);
  });

  it('formats points with a decimal comma', () => {
    expect(formatPoints(17)).toBe('17');
    expect(formatPoints(8.5)).toBe('8,5');
    expect(formatPoints(66.25)).toBe('66,25');
    expect(formatPoints(0.125)).toBe('0,13');
    expect(formatPoints(-0)).toBe('0');
  });
});

describe('gradeItemsPath', () => {
  it('is scoped to the user with a fixed column list', () => {
    expect(gradeItemsPath(USER)).toBe(
      `moodle_grade_items?user_id=eq.${USER}&select=course_id,item_id,course_name,item_name,item_type,item_module,cmid,item_instance,category_id,sort_order,report_depth,grade_raw,grade_min,grade_max,grade_formatted,percentage_formatted,weight_raw,graded_at,fetched_at&order=course_name.asc,course_id.asc,sort_order.asc&limit=3000`,
    );
  });

  it('rejects a user id that is not a uuid', () => {
    expect(() => gradeItemsPath('x')).toThrow();
  });
});

describe('parseGradeRows', () => {
  it('coerces numeric strings and integer ids', () => {
    const [parsed] = parseGradeRows([{ course_id: '10', item_id: 5, item_type: 'mod', grade_raw: '17.5', sort_order: '2' }]);
    expect(parsed).toMatchObject({ course_id: 10, item_id: 5, grade_raw: 17.5, sort_order: 2, course_name: '', item_name: null, weight_raw: null });
  });

  it('drops malformed rows and non-arrays', () => {
    expect(parseGradeRows([{ course_id: 1, item_type: 'mod' }, { course_id: 1, item_id: 2, item_type: 5 }, null, 'x'])).toEqual([]);
    expect(parseGradeRows({ not: 'an array' })).toEqual([]);
    expect(parseGradeRows(null)).toEqual([]);
  });
});

describe('direct points (activities are worth their maximum)', () => {
  it('a course with few activities so far is not shown as a percentage', () => {
    const rows = [
      row({ course_id: 30, course_name: 'Estadística', item_id: 1, item_type: 'course', item_instance: 31, category_id: null, grade_raw: 80 }),
      row({ course_id: 30, course_name: 'Estadística', item_id: 2, item_type: 'mod', item_name: 'Evaluación # 1', grade_raw: 4, grade_max: 5, graded_at: 1 }),
      row({ course_id: 30, course_name: 'Estadística', item_id: 3, item_type: 'mod', grade_max: 10 }),
      row({ course_id: 30, course_name: 'Estadística', item_id: 4, item_type: 'mod', grade_max: 10 }),
    ];
    expect(computeCourseStanding(rows)).toMatchObject({
      method: 'points',
      estimate: false,
      earned: 4,
      spent: 5,
      available: 95,
      needed: 66,
      status: 'on_track',
      pendingItems: 2,
    });
  });

  it('a course whose Moodle total is missing still counts its graded activities', () => {
    const rows = [
      row({ course_id: 31, course_name: 'Redes', item_id: 1, item_type: 'course', item_instance: 31, category_id: null, grade_raw: null }),
      row({ course_id: 31, course_name: 'Redes', item_id: 2, item_type: 'mod', grade_raw: 10, grade_max: 10, graded_at: 1 }),
      row({ course_id: 31, course_name: 'Redes', item_id: 3, item_type: 'mod', grade_raw: 0, grade_max: 10, graded_at: 2 }),
      row({ course_id: 31, course_name: 'Redes', item_id: 4, item_type: 'mod', grade_max: 10 }),
      row({ course_id: 31, course_name: 'Redes', item_id: 5, item_type: 'mod', grade_max: 10 }),
    ];
    expect(computeCourseStanding(rows)).toMatchObject({
      method: 'points',
      earned: 10,
      spent: 20,
      available: 80,
      needed: 60,
      status: 'at_risk',
    });
  });

  it('maxima above 100 fall back to the next method', () => {
    const rows = [
      row({ course_id: 32, course_name: 'Química II', item_id: 1, item_type: 'course', item_instance: 31, category_id: null, grade_raw: 50 }),
      row({ course_id: 32, course_name: 'Química II', item_id: 2, item_type: 'mod', weight_raw: 0.5, grade_raw: 40, grade_max: 100, graded_at: 1 }),
      row({ course_id: 32, course_name: 'Química II', item_id: 3, item_type: 'mod', weight_raw: 0.5, grade_max: 50 }),
    ];
    expect(computeCourseStanding(rows)).toMatchObject({ method: 'weights' });
    // Without weights the same maxima fall back to the course total.
    expect(computeCourseStanding(rows.map((r) => ({ ...r, weight_raw: null })))).toMatchObject({ method: 'estimate', earned: 50 });
  });

  it('an unlinked exam adds its points directly', () => {
    const s = computeCourseStanding(A, [{ course_id: 10, kind: 'final', grade: 15, max_points: 15, linked_item_id: null }]);
    expect(s).toMatchObject({ method: 'points', earned: 32, spent: 35, available: 65 });
  });
});

describe('manual exam grades', () => {
  const exam = (o: Partial<ManualGradeRow> & Pick<ManualGradeRow, 'kind'>): ManualGradeRow => ({
    course_id: 10,
    grade: null,
    max_points: 15,
    linked_item_id: null,
    ...o,
  });

  it('asks for both exams while nothing was entered', () => {
    const s = computeCourseStanding(A);
    expect(s.exams.map((e) => [e.kind, e.state, e.maxPoints])).toEqual([
      ['midterm', 'missing', 15],
      ['final', 'missing', 15],
    ]);
    expect(s.linkable.map((i) => i.itemId)).toEqual([501, 502, 503]);
  });

  it('a grade linked to an ungraded Moodle activity replaces it with the same weight', () => {
    const s = computeCourseStanding(A, [exam({ kind: 'midterm', grade: 12, linked_item_id: 502 })]);
    // 12/15 = 0.8 of the 30-point activity.
    expect(s).toMatchObject({ method: 'points', earned: 41, spent: 50, available: 50, needed: 29 });
    expect(s.exams[0]).toMatchObject({ state: 'manual', linkedItemId: 502, linkedItemName: 'Examen parcial' });
    const item = s.graded.find((g) => g.itemId === 502);
    expect(item).toMatchObject({ manual: true, contribution: 24 });
    expect(s.pendingItems).toBe(1);
  });

  it('Moodle wins once the linked activity has its own grade', () => {
    const s = computeCourseStanding(A, [exam({ kind: 'midterm', grade: 2, linked_item_id: 501 })]);
    expect(s.earned).toBe(17);
    expect(s.exams[0].state).toBe('moodle');
    expect(s.graded.every((g) => !g.manual)).toBe(true);
  });

  it('an unlinked grade is a fixed block and the Moodle part fills the remaining points', () => {
    const s = computeCourseStanding(A, [exam({ kind: 'final', grade: 15 })]);
    // Direct points: the block adds its 15 points as they are; spent 20 + 15 = 35.
    expect(s).toMatchObject({ earned: 32, spent: 35, available: 65, status: 'on_track' });
    expect(s.graded[0]).toMatchObject({ itemId: -1, name: 'Examen de fin de ciclo', manual: true, contribution: 15 });
    expect(s.graded.find((g) => g.itemId === 501)?.contribution).toBe(17);
    expect(s.exams[1].state).toBe('manual');
  });

  it('an exam marked as not applicable or as a Moodle item changes no points', () => {
    const s = computeCourseStanding(A, [
      exam({ kind: 'midterm', linked_item_id: 502 }),
      exam({ kind: 'final' }),
    ]);
    expect(s.earned).toBe(17);
    expect(s.exams.map((e) => e.state)).toEqual(['linked', 'none']);
  });

  it('a link to an activity that no longer exists counts as an unlinked block', () => {
    const s = computeCourseStanding(A, [exam({ kind: 'midterm', grade: 15, linked_item_id: 999 })]);
    expect(s.earned).toBe(32);
    expect(s.exams[0]).toMatchObject({ state: 'manual', linkedItemId: null });
  });

  it('a course without Moodle grades is projected from the exam blocks alone', () => {
    const only = [row({ course_id: 13, course_name: 'Inglés', item_id: 800, item_type: 'course' })];
    const s = computeCourseStanding(only, [exam({ course_id: 13, kind: 'midterm', grade: 12 })]);
    expect(s).toMatchObject({ method: 'manual', earned: 12, spent: 15, available: 85, status: 'on_track' });
  });

  it('buildStandings hands each course only its own exams', () => {
    const list = buildStandings([...A, ...C], [exam({ course_id: 12, kind: 'final', grade: 10 })]);
    expect(list.find((s) => s.courseId === 10)?.exams.every((e) => e.state === 'missing')).toBe(true);
    expect(list.find((s) => s.courseId === 12)?.exams[1].state).toBe('manual');
  });

  it('parseManualRows keeps only valid rows', () => {
    expect(
      parseManualRows([
        { course_id: 10, kind: 'midterm', grade: '12.5', max_points: 15, linked_item_id: null },
        { course_id: 10, kind: 'final', grade: null, max_points: 15, linked_item_id: 502 },
        { course_id: 10, kind: 'quiz', grade: 1, max_points: 15 },
        { course_id: 10, kind: 'final', grade: 'x', max_points: 15 },
        { course_id: 10, kind: 'final', grade: 1, max_points: 0 },
        null,
      ]),
    ).toEqual([
      { course_id: 10, kind: 'midterm', grade: 12.5, max_points: 15, linked_item_id: null },
      { course_id: 10, kind: 'final', grade: null, max_points: 15, linked_item_id: 502 },
    ]);
    expect(parseManualRows({})).toEqual([]);
  });

  it('manualGradesPath is scoped to the user', () => {
    expect(manualGradesPath(USER)).toBe(
      `moodle_manual_grades?user_id=eq.${USER}&select=course_id,kind,grade,max_points,linked_item_id&limit=500`,
    );
  });
});

describe('activities worth 0 points', () => {
  it('a 0-point activity does not block direct points nor count as pending (Moodle SCORM case)', () => {
    const rows = [
      row({ course_id: 20, item_id: 1, item_type: 'mod', item_name: 'Sentencia Join', item_module: 'scorm', grade_max: 0, weight_raw: 0 }),
      row({ course_id: 20, item_id: 2, item_type: 'mod', item_name: 'Autónoma # 1', grade_max: 5, weight_raw: 0 }),
      row({ course_id: 20, item_id: 3, item_type: 'mod', item_name: 'Evaluación # 1', grade_raw: 4, grade_max: 5, weight_raw: 1, graded_at: 1 }),
      row({ course_id: 20, item_id: 4, item_type: 'course', category_id: null, grade_raw: 4, grade_max: 5 }),
    ];
    expect(computeCourseStanding(rows)).toMatchObject({
      method: 'points',
      estimate: false,
      earned: 4,
      spent: 5,
      available: 95,
      needed: 66,
      pendingItems: 1,
    });
  });
});
