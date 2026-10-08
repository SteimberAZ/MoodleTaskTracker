'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth';
import { deleteManualGrade, EXAM_SAVE_FAILURE, loadCourseRows, saveManualGrade } from '@/lib/grades-store';
import { parseCourseAndKind, parseExamForm } from '@/lib/manual-exams';

export interface ExamFormState {
  error?: string;
  saved?: number;
}

const STATS_PATH = '/estadisticas';

/** Saves the session user's exam entry; the course and link are checked against that user's own stored rows. */
export async function saveExam(_prev: ExamFormState, formData: FormData): Promise<ExamFormState> {
  const user = await requireUser();
  const target = parseCourseAndKind(formData);
  if (!target) return { error: 'Datos del examen no válidos.' };
  try {
    const parsed = parseExamForm(formData, await loadCourseRows(user.id, target.courseId));
    if (!parsed.ok) return { error: parsed.error };
    await saveManualGrade(user.id, parsed.value);
  } catch {
    return { error: EXAM_SAVE_FAILURE };
  }
  revalidatePath(STATS_PATH);
  return { saved: Date.now() };
}

/** Removes the session user's exam entry, so the card asks for it again. */
export async function deleteExam(_prev: ExamFormState, formData: FormData): Promise<ExamFormState> {
  const user = await requireUser();
  const target = parseCourseAndKind(formData);
  if (!target) return { error: 'Datos del examen no válidos.' };
  try {
    await deleteManualGrade(user.id, target.courseId, target.kind);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'No se pudo borrar el examen.' };
  }
  revalidatePath(STATS_PATH);
  return { saved: Date.now() };
}
