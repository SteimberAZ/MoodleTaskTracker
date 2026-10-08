import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import CourseGradeCard from '@/components/CourseGradeCard';
import { computeCourseStanding, type CourseStanding, type GradeItemRow } from '@/lib/grades';

vi.mock('@/app/estadisticas/actions', () => ({ saveExam: vi.fn(), deleteExam: vi.fn() }));

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

const onTrack = [
  row({ course_id: 10, item_id: 500, item_type: 'course', item_instance: 31, category_id: null, grade_raw: 17 }),
  row({ course_id: 10, item_id: 501, item_type: 'mod', item_name: 'Tarea 1', weight_raw: 0.2, grade_raw: 17, grade_max: 20, graded_at: 1799950000 }),
  row({ course_id: 10, item_id: 502, item_type: 'mod', weight_raw: 0.3, grade_max: 30 }),
  row({ course_id: 10, item_id: 503, item_type: 'mod', weight_raw: 0.5, grade_max: 50 }),
];
const passed = [
  row({ course_id: 13, item_id: 800, item_type: 'course', item_instance: 31, category_id: null, grade_raw: 85 }),
  row({ course_id: 13, item_id: 801, item_type: 'mod', weight_raw: 0.5, grade_raw: 45, grade_max: 50 }),
  row({ course_id: 13, item_id: 802, item_type: 'mod', weight_raw: 0.5, grade_raw: 40, grade_max: 50 }),
];
const lost = [
  row({ course_id: 12, item_id: 700, item_type: 'course', grade_raw: 20 }),
  row({ course_id: 12, item_id: 701, item_type: 'mod', grade_max: 40, grade_raw: 10, graded_at: 1 }),
  row({ course_id: 12, item_id: 702, item_type: 'mod', grade_max: 40, grade_raw: 10, graded_at: 2 }),
  row({ course_id: 12, item_id: 703, item_type: 'mod', grade_max: 20 }),
];
const estimate = [
  row({ course_id: 14, item_id: 900, item_type: 'course', grade_raw: 8, grade_max: 20 }),
  // Maxima add up to 120: not direct points, so the course total is the estimate.
  row({ course_id: 14, item_id: 901, item_type: 'mod', grade_max: 60, grade_raw: 8 }),
  row({ course_id: 14, item_id: 902, item_type: 'mod', grade_max: 60 }),
];
// Course total renormalized over the graded items (9/10 graded, rest open): the estimate reads 90/100.
const renormalized = [
  row({ course_id: 21, item_id: 1, item_type: 'course', item_instance: 31, category_id: null, grade_raw: 90, grade_max: 100 }),
  row({ course_id: 21, item_id: 2, item_type: 'mod', weight_raw: 1, grade_raw: 9, grade_max: 10, graded_at: 5 }),
  row({ course_id: 21, item_id: 3, item_type: 'mod', weight_raw: 0, grade_max: 60 }),
  row({ course_id: 21, item_id: 4, item_type: 'mod', weight_raw: 0, grade_max: 60 }),
];
const empty = [
  row({ course_id: 15, item_id: 1000, item_type: 'course', item_instance: 31, category_id: null }),
  row({ course_id: 15, item_id: 1001, item_type: 'mod', weight_raw: 0.4, grade_max: 40 }),
  row({ course_id: 15, item_id: 1002, item_type: 'mod', weight_raw: 0.6, grade_max: 60 }),
];

const render = (rows: GradeItemRow[]): { standing: CourseStanding; html: string } => {
  const standing = computeCourseStanding(rows);
  return { standing, html: renderToStaticMarkup(createElement(CourseGradeCard, { standing })) };
};

describe('CourseGradeCard', () => {
  it('shows an on-track course with its remaining need and graded items', () => {
    const { html } = render(onTrack);
    expect(html).toContain('En camino');
    expect(html).toContain('17</strong>');
    expect(html).toContain('Te faltan <strong>53 puntos</strong>');
    expect(html).toContain('Puntos aún por calificar: 80');
    expect(html).toContain('Tarea 1');
    expect(html).toContain('17/20');
    expect(html).toContain('+17 pts');
    expect(html).toContain('style="left:70%"');
    expect(html).toContain('aria-label="17 de 100 puntos; se aprueba con 70"');
    expect(html).toContain('2 actividades sin calificar');
    expect(html).not.toContain('¡Aprobado!');
  });

  it('shows a passed course as passed and never asks for more points', () => {
    const { html } = render(passed);
    expect(html).toContain('¡Aprobado!');
    expect(html).toContain('Aprobada');
    expect(html).toContain('grade-bar-fill is-passed');
    expect(html).not.toContain('Te faltan');
  });

  it('warns that 70 is no longer reachable when the course is lost', () => {
    const { html } = render(lost);
    expect(html).toContain('No alcanza');
    expect(html).toContain('ya no llegas a 70');
    expect(html).toContain('como máximo sumarías 40 puntos');
  });

  it('marks an estimate without per-activity contributions', () => {
    const { html } = render(estimate);
    expect(html).toContain('Estimado');
    expect(html).toContain('Estimado con el total del curso');
    expect(html).not.toContain('grade-item-points');
    expect(html).not.toContain('Puntos aún por calificar');
  });

  it('does not show an estimate with pending activities as passed', () => {
    const { standing, html } = render(renormalized);
    expect(standing.status).toBe('unknown');
    expect(html).toContain('90</strong>');
    expect(html).toContain('Estimado');
    expect(html).toContain('Estimado con el total del curso');
    expect(html).not.toContain('¡Aprobado!');
    expect(html).not.toContain('Aprobada');
    expect(html).not.toContain('is-passed');
    expect(html).not.toContain('Te faltan');
    expect(html).toContain('todavía no se puede confirmar si apruebas');
    expect(html).toContain('2 actividades sin calificar');
  });

  it('tells a course without grades that there is nothing to show yet', () => {
    const { html } = render(empty);
    expect(html).toContain('Sin notas');
    expect(html).toContain('Aún no tienes notas en esta materia.');
    expect(html).not.toContain('Te faltan');
  });
});

describe('CourseGradeCard exams', () => {
  const html = (examsEnabled: boolean, manual = [] as Parameters<typeof computeCourseStanding>[1]) =>
    renderToStaticMarkup(createElement(CourseGradeCard, { standing: computeCourseStanding(onTrack, manual), examsEnabled }));

  it('asks for both exams while the table exists and nothing was entered', () => {
    const out = html(true);
    expect(out).toContain('¿Ya diste tu examen de medio ciclo? Agrégalo');
    expect(out).toContain('¿Ya diste tu examen de fin de ciclo? Agrégalo');
    expect(out).toContain('name="grade"');
  });

  it('hides the exam forms until the table exists', () => {
    expect(html(false)).not.toContain('Agrégalo');
  });

  it('tags an entered exam as the student own grade', () => {
    const out = html(true, [{ course_id: onTrack[0].course_id, kind: 'final', grade: 12, max_points: 15, linked_item_id: null }]);
    expect(out).toContain('Examen de fin de ciclo: 12/15 (nota tuya)');
    expect(out).toContain('(nota tuya)</span>');
  });
});
