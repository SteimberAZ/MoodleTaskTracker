'use client';

import { useEffect, useReducer, useRef, useState, useTransition, type ReactNode } from 'react';
import { saveEditedSchedule, saveImportedSchedule, type SchedulePreview } from '@/app/horario/actions';
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
import ScheduleEditor from './ScheduleEditor';
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

/**
 * Everything on /horario that touches the schedule: the saved schedule, the PDF picker, the preview of a
 * draft (with Guardar / Editar / Cancelar) and the editor. A draft only replaces the stored schedule on save.
 */
export default function ScheduleWorkspace({
  saved,
  today,
  extraActions,
}: {
  saved: ScheduleClass[];
  today: number;
  extraActions?: ReactNode;
}) {
  const [mode, setMode] = useState<Mode>(saved.length > 0 ? 'view' : 'upload');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [entries, dispatch] = useReducer(editorReducer, [] as EditorEntry[]);
  const [showErrors, setShowErrors] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [saving, startSave] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const previousMode = useRef<Mode>(mode);

  // A deleted schedule leaves nothing to show: fall back to the picker.
  const current: Mode = mode === 'view' && saved.length === 0 ? 'upload' : mode;
  const validation = validateEditor(entries);

  // Bring the new step into view when the screen changes (not on first render).
  useEffect(() => {
    if (previousMode.current !== current) {
      previousMode.current = current;
      if (current === 'view' && justSaved) bannerRef.current?.focus();
      rootRef.current?.scrollIntoView({ block: 'start' });
    }
  }, [current, justSaved]);

  function openDraft(next: Draft, nextMode: Mode) {
    setDraft(next);
    dispatch({ type: 'reset', entries: next.initial });
    setShowErrors(false);
    setSaveError(null);
    setJustSaved(false);
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
      setMode('view');
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
              <span>
                Ahora elige cuánto antes quieres el aviso de cada clase.{' '}
                <a className="link" href="#class-reminder-title">
                  Ir a Avisos de clases
                </a>
              </span>
            </div>
          )}
          <div className="actions">
            <button type="button" className="btn primary" onClick={editSaved}>
              Editar horario
            </button>
            <button type="button" className="btn" onClick={() => setMode('upload')}>
              Volver a importar
            </button>
            {extraActions}
          </div>
          <ScheduleDays items={savedItems} today={today} />
        </>
      )}

      {current === 'upload' && (
        <div className="card item">
          <h2 className="card-title">{saved.length > 0 ? 'Volver a importar' : 'Importa tu horario'}</h2>
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
            <h2>Revisa tu horario</h2>
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
