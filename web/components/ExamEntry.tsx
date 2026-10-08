'use client';

import { useActionState, useEffect, useRef } from 'react';
import { deleteExam, saveExam, type ExamFormState } from '@/app/estadisticas/actions';
import { formatPoints, type ExamEntry as Exam, type LinkableItem } from '@/lib/grades';

/** The collapsed line of an exam: a question while it is missing, its state otherwise. */
export function examSummary(exam: Exam): string {
  const short = exam.kind === 'midterm' ? 'medio ciclo' : 'fin de ciclo';
  switch (exam.state) {
    case 'missing':
      return `¿Ya diste tu examen de ${short}? Agrégalo`;
    case 'manual':
      return `${exam.label}: ${formatPoints(exam.grade ?? 0)}/${formatPoints(exam.maxPoints)} (nota tuya)`;
    case 'moodle':
      return `${exam.label}: Moodle ya tiene la nota`;
    case 'linked':
      return `${exam.label}: en Moodle como «${exam.linkedItemName ?? ''}», sin nota todavía`;
    case 'none':
      return `${exam.label}: esta materia no lo tiene`;
  }
}

/**
 * One exam of a course card: a disclosure with the form to enter the grade (out of 15 by default), link it to the
 * Moodle activity that is that exam, or mark that the course has no such exam. Closes itself after a save.
 */
export default function ExamEntry({ courseId, exam, linkable }: { courseId: number; exam: Exam; linkable: LinkableItem[] }) {
  const [saveState, saveAction, saving] = useActionState(saveExam, {} as ExamFormState);
  const [deleteState, deleteAction, deleting] = useActionState(deleteExam, {} as ExamFormState);
  const details = useRef<HTMLDetailsElement>(null);
  const error = saveState.error ?? deleteState.error;

  useEffect(() => {
    if ((saveState.saved || deleteState.saved) && details.current) details.current.open = false;
  }, [saveState.saved, deleteState.saved]);

  const id = `exam-${courseId}-${exam.kind}`;
  const missing = exam.state === 'missing';

  return (
    <details ref={details} className={`exam-entry${missing ? ' is-missing' : ''}`}>
      <summary>{examSummary(exam)}</summary>
      <form action={saveAction} className="exam-form">
        <input type="hidden" name="course_id" value={courseId} />
        <input type="hidden" name="kind" value={exam.kind} />
        <div className="exam-fields">
          <label htmlFor={`${id}-grade`}>
            Tu nota
            <input
              id={`${id}-grade`}
              name="grade"
              inputMode="decimal"
              autoComplete="off"
              placeholder="12,5"
              defaultValue={exam.grade === null ? '' : formatPoints(exam.grade)}
            />
          </label>
          <label htmlFor={`${id}-max`}>
            Sobre
            <input
              id={`${id}-max`}
              name="max_points"
              inputMode="decimal"
              autoComplete="off"
              defaultValue={formatPoints(exam.maxPoints)}
            />
          </label>
        </div>
        {linkable.length > 0 && (
          <label htmlFor={`${id}-link`}>
            ¿Está en Moodle? (opcional)
            <select id={`${id}-link`} name="linked_item_id" defaultValue={exam.linkedItemId ?? ''}>
              <option value="">No está en Moodle</option>
              {linkable.map((item) => (
                <option key={item.itemId} value={item.itemId}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="muted small">
          Si el examen ya aparece en Moodle, elígelo para no contarlo dos veces. Cuando el profesor suba la nota, se usa
          la de Moodle.
        </p>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
          <button type="submit" name="no_exam" value="1" className="btn" disabled={saving}>
            Esta materia no lo tiene
          </button>
        </div>
      </form>
      {!missing && (
        <form action={deleteAction} className="exam-delete">
          <input type="hidden" name="course_id" value={courseId} />
          <input type="hidden" name="kind" value={exam.kind} />
          <button type="submit" className="btn ghost" disabled={deleting}>
            {deleting ? 'Borrando…' : 'Borrar'}
          </button>
        </form>
      )}
    </details>
  );
}
