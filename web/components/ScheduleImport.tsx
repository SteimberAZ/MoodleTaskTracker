'use client';

import { useActionState, useState, type ReactNode } from 'react';
import {
  previewSchedule,
  saveSchedule,
  type ImportState,
  type SaveState,
  type SchedulePreview,
} from '@/app/horario/actions';
import ScheduleDays from './ScheduleDays';

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Upload -> preview -> confirm. The PDF is read on the server and never stored; the preview carries a signed copy
 * of the parsed classes. With an existing schedule the form starts collapsed behind "Volver a importar".
 */
export default function ScheduleImport({ hasSchedule, extraActions }: { hasSchedule: boolean; extraActions?: ReactNode }) {
  const [open, setOpen] = useState(!hasSchedule);
  const [state, formAction, pending] = useActionState(previewSchedule, {} as ImportState);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const preview = state.preview && state.preview.token !== dismissed ? state.preview : null;

  if (!open) {
    return (
      <div className="actions">
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Volver a importar
        </button>
        {extraActions}
      </div>
    );
  }

  return (
    <div className="stack">
      {!preview && (
        <form action={formAction} className="form" onSubmit={(e) => fileError && e.preventDefault()}>
          <label>
            Archivo PDF del horario (máximo 2 MB)
            <input
              type="file"
              name="file"
              accept="application/pdf,.pdf"
              required
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                if (file && file.size > MAX_BYTES) setFileError('El archivo supera los 2 MB.');
                else if (file && file.type && file.type !== 'application/pdf') setFileError('Elige un archivo PDF.');
                else setFileError(null);
              }}
            />
          </label>
          {(fileError || state.error) && (
            <p className="alert" role="alert">
              {fileError ?? state.error}
            </p>
          )}
          <div className="actions">
            <button type="submit" className="btn primary" disabled={pending || !!fileError}>
              {pending ? 'Leyendo PDF…' : 'Ver vista previa'}
            </button>
            {hasSchedule && (
              <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
                Cancelar
              </button>
            )}
          </div>
          <p className="muted small">El PDF se lee en el servidor y no se guarda: solo se conservan las clases que confirmes.</p>
        </form>
      )}
      {preview && (
        <SchedulePreviewForm
          key={preview.token}
          preview={preview}
          replaces={hasSchedule}
          onCancel={() => setDismissed(preview.token)}
          onDone={() => {
            setDismissed(preview.token);
            if (hasSchedule) setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function SchedulePreviewForm({
  preview,
  replaces,
  onCancel,
  onDone,
}: {
  preview: SchedulePreview;
  replaces: boolean;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(saveSchedule, {} as SaveState);

  if (state.saved) {
    return (
      <div className="stack">
        <p className="success" role="status">
          Horario guardado: {state.saved} {state.saved === 1 ? 'clase' : 'clases'}.
        </p>
        <div className="actions">
          <button type="button" className="btn" onClick={onDone}>
            Listo
          </button>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="stack">
      <input type="hidden" name="token" value={preview.token} />
      <div className="page-head">
        <h2>Revisa tu horario</h2>
        <p className="muted">
          {preview.periodLabel ? `Período: ${preview.periodLabel}. ` : ''}
          {preview.classes.length} {preview.classes.length === 1 ? 'clase' : 'clases'} encontradas.
          {replaces ? ' Al guardar se reemplaza tu horario actual.' : ''} Desmarca las que no quieras guardar.
        </p>
      </div>
      {preview.warnings.length > 0 && (
        <ul className="warning plain-list" role="status">
          {preview.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <ScheduleDays
        items={preview.classes.map((cls, index) => ({ cls, index }))}
        extra={({ index }) => (
          <label className="class-check">
            <input type="checkbox" name="keep" value={index} defaultChecked />
            <span>Incluir</span>
          </label>
        )}
      />
      {state.error && (
        <p className="alert" role="alert">
          {state.error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? 'Guardando…' : 'Guardar horario'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
