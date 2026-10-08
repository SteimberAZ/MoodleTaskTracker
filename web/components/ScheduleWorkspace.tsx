'use client';

import { useEffect, useReducer, useRef, useState, useTransition } from 'react';
import { deleteSchedule, saveEditedSchedule, saveImportedSchedule, type SchedulePreview } from '@/app/horario/actions';
import { leadLabel } from '@/lib/class-schedule';
import {
  classesToEntries,
  editorReducer,
  entriesToClasses,
  isDirty,
  validateEditor,
  type EditorEntry,
} from '@/lib/schedule-editor';
import type { ScheduleClass } from '@/lib/sga-schedule';
import ScheduleActionBar from './ScheduleActionBar';
import ScheduleDays from './ScheduleDays';
import ScheduleEditor, { SCHEDULE_EDIT_TITLE_ID } from './ScheduleEditor';
import SchedulePicker from './SchedulePicker';

type Mode = 'view' | 'upload' | 'preview' | 'edit';

/** The schedule being reviewed or edited before it is saved. */
interface Draft {
  /** `import`: parsed from a PDF (saved with its signed token). `saved`: the stored rows being edited. */
  source: 'import' | 'saved';
  token: string | null;
  warnings: string[];
  initial: EditorEntry[];
  periodLabel: string | null;
}

const countLabel = (n: number): string => `${n} ${n === 1 ? 'clase' : 'clases'}`;

const DELETE_MESSAGE = '¿Borrar tu horario de clases? Dejarás de recibir avisos de clases hasta que lo importes de nuevo.';

/**
 * Everything on /horario that touches the schedule: the saved schedule, the PDF picker, the preview of a
 * draft (with Guardar / Editar / Cancelar) and the editor. A draft only replaces the stored schedule on save.
 * Every step change after the first render scrolls the workspace into view and moves focus to the new step's
 * heading (or the save confirmation), so keyboard and screen reader users follow along.
 */
export default function ScheduleWorkspace({ saved, today }: { saved: ScheduleClass[]; today: number }) {
  const [mode, setMode] = useState<Mode>(saved.length > 0 ? 'view' : 'upload');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [entries, dispatch] = useReducer(editorReducer, [] as EditorEntry[]);
  const [showErrors, setShowErrors] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  /** Lead time the first save switched on (minutes), shown in the confirmation. */
  const [defaultLead, setDefaultLead] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [deleting, startDelete] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const uploadTitleRef = useRef<HTMLHeadingElement>(null);
  const previewTitleRef = useRef<HTMLHeadingElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const previousMode = useRef<Mode>(mode);

  // A deleted schedule leaves nothing to show: fall back to the picker.
  const current: Mode = mode === 'view' && saved.length === 0 ? 'upload' : mode;
  const validation = validateEditor(entries);

  // Bring the new step into view and focus its heading when the screen changes (not on first render).
  useEffect(() => {
    if (previousMode.current === current) return;
    previousMode.current = current;
    rootRef.current?.scrollIntoView({ block: 'start' });
    const target: HTMLElement | null =
      current === 'upload'
        ? uploadTitleRef.current
        : current === 'preview'
          ? previewTitleRef.current
          : current === 'edit'
            ? document.getElementById(SCHEDULE_EDIT_TITLE_ID)
            : justSaved
              ? bannerRef.current
              : editButtonRef.current;
    target?.focus({ preventScroll: true });
  }, [current, justSaved]);

  function openDraft(next: Draft, nextMode: Mode) {
    setDraft(next);
    dispatch({ type: 'reset', entries: next.initial });
    setShowErrors(false);
    setSaveError(null);
    setJustSaved(false);
    setDefaultLead(null);
    setDeleteError(null);
    setMode(nextMode);
  }

  function onPreview(preview: SchedulePreview) {
    openDraft(
      {
        source: 'import',
        token: preview.token,
        warnings: preview.warnings,
        initial: classesToEntries(preview.classes),
        periodLabel: preview.periodLabel,
      },
      'preview',
    );
  }

  function editSaved() {
    openDraft({ source: 'saved', token: null, warnings: [], initial: classesToEntries(saved), periodLabel: null }, 'edit');
  }

  function cancelDraft() {
    if (draft && isDirty(entries, draft.initial) && !window.confirm('¿Descartar los cambios que hiciste?')) return;
    setDraft(null);
    setSaveError(null);
    setShowErrors(false);
    setMode(saved.length > 0 ? 'view' : 'upload');
  }

  function finishEditing() {
    if (!validation.valid) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setMode('preview');
  }

  function save() {
    if (!draft) return;
    if (!validation.valid) {
      setShowErrors(true);
      setMode('edit');
      return;
    }
    setSaveError(null);
    const classes = entriesToClasses(entries);
    startSave(async () => {
      let result;
      try {
        result =
          draft.source === 'import'
            ? await saveImportedSchedule({ token: draft.token, entries: classes })
            : await saveEditedSchedule({ entries: classes });
      } catch {
        setSaveError('No se pudo guardar el horario. Inténtalo de nuevo.');
        return;
      }
      if (result.error) {
        setSaveError(result.error);
        return;
      }
      setDraft(null);
      setJustSaved(true);
      setDefaultLead(result.defaultLead ?? null);
      setMode('view');
    });
  }

  function removeSchedule() {
    if (!window.confirm(DELETE_MESSAGE)) return;
    setDeleteError(null);
    startDelete(async () => {
      try {
        const result = await deleteSchedule();
        if (result.error) setDeleteError(result.error);
        // On success the refreshed page has no saved classes and the workspace falls back to the picker.
      } catch {
        setDeleteError('No se pudo borrar el horario. Inténtalo de nuevo.');
      }
    });
  }

  const savedItems = saved.map((cls, index) => ({ cls, index }));

  return (
    <div className="stack workspace" ref={rootRef}>
      {current === 'view' && (
        <>
          {justSaved && (
            <div className="success save-banner" role="status" tabIndex={-1} ref={bannerRef}>
              <strong>Horario guardado ✓</strong>
              {defaultLead ? (
                <span>
                  Te avisaremos {leadLabel(defaultLead)} antes de cada clase ·{' '}
                  <a className="link" href="#class-reminder-title">
                    Cambiar
                  </a>
                </span>
              ) : (
                <span>
                  Ahora elige cuánto antes quieres el aviso de cada clase.{' '}
                  <a className="link" href="#class-reminder-title">
                    Ir a Avisos de clases
                  </a>
                </span>
              )}
            </div>
          )}
          <div className="actions">
            <button type="button" className="btn primary" onClick={editSaved} ref={editButtonRef}>
              Editar horario
            </button>
            <button type="button" className="btn" onClick={() => setMode('upload')}>
              Volver a importar
            </button>
            <button type="button" className="btn danger" onClick={removeSchedule} disabled={deleting}>
              {deleting ? 'Borrando…' : 'Borrar horario'}
            </button>
          </div>
          {deleteError && (
            <p className="alert" role="alert">
              {deleteError}
            </p>
          )}
          <ScheduleDays items={savedItems} today={today} headingLevel={2} />
        </>
      )}

      {current === 'upload' && (
        <div className="card item">
          <h2 className="card-title" ref={uploadTitleRef} tabIndex={-1}>
            {saved.length > 0 ? 'Volver a importar' : 'Importa tu horario'}
          </h2>
          <p className="muted">
            En el SGA abre «Horario de clases», imprime o descarga la página como PDF y elígela aquí. Verás tu horario antes de guardarlo y
            podrás corregirlo.
          </p>
          <SchedulePicker onPreview={onPreview} onCancel={saved.length > 0 ? () => setMode('view') : undefined} />
        </div>
      )}

      {draft && current === 'preview' && (
        <>
          <div className="page-head">
            <h2 ref={previewTitleRef} tabIndex={-1}>
              Revisa tu horario
            </h2>
            <p className="muted">
              {draft.periodLabel ? `Período: ${draft.periodLabel}. ` : ''}
              {countLabel(entries.length)}. {saved.length > 0 ? 'Al guardar se reemplaza tu horario actual. ' : ''}
              Puedes corregir lo que haga falta con «Editar».
            </p>
          </div>
          {draft.warnings.length > 0 && (
            <ul className="warning plain-list" role="status">
              {draft.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <ScheduleDays items={entriesToClasses(entries).map((cls, index) => ({ cls, index }))} />
          {saveError && (
            <p className="alert" role="alert">
              {saveError}
            </p>
          )}
          <ScheduleActionBar
            busy={saving}
            onSave={save}
            onCancel={cancelDraft}
            secondary={{ label: 'Editar', onClick: () => setMode('edit') }}
          />
        </>
      )}

      {draft && current === 'edit' && (
        <>
          <ScheduleEditor entries={entries} dispatch={dispatch} validation={validation} showErrors={showErrors} />
          {showErrors && !validation.valid && (
            <p className="alert" role="alert">
              Revisa los campos marcados antes de continuar.
            </p>
          )}
          {saveError && (
            <p className="alert" role="alert">
              {saveError}
            </p>
          )}
          <ScheduleActionBar
            busy={saving}
            onSave={save}
            onCancel={cancelDraft}
            secondary={{ label: 'Listo', onClick: finishEditing }}
          />
        </>
      )}
    </div>
  );
}
