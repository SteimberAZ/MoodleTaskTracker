'use client';

import { useActionState, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { previewSchedule, type ImportState, type SchedulePreview } from '@/app/horario/actions';
import { pdfFileProblem } from '@/lib/schedule-editor';

/** Placeholder day cards shown while the PDF is being read. */
function ScheduleSkeleton() {
  return (
    <div className="skeleton-days" aria-hidden="true">
      {[0, 1, 2].map((day) => (
        <div key={day} className="skeleton-day">
          <span className="skeleton-line skeleton-title" />
          <div className="skeleton-card">
            <span className="skeleton-line skeleton-time" />
            <span className="skeleton-line skeleton-text" />
          </div>
          {day === 0 && (
            <div className="skeleton-card">
              <span className="skeleton-line skeleton-time" />
              <span className="skeleton-line skeleton-text" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * PDF picker. Choosing a file uploads it right away (no extra click): the input submits its own form. While the
 * server reads the PDF a spinner and skeleton day cards are shown. Without JavaScript the `<noscript>` button submits.
 */
export default function SchedulePicker({
  onPreview,
  onCancel,
}: {
  onPreview: (preview: SchedulePreview) => void;
  /** Present when there is a saved schedule to go back to. */
  onCancel?: () => void;
}) {
  const [state, formAction, pending] = useActionState(previewSchedule, {} as ImportState);
  const [fileError, setFileError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const delivered = useRef<string | null>(null);

  // Hand the parsed schedule to the parent exactly once per upload.
  useEffect(() => {
    if (state.preview && delivered.current !== state.preview.token) {
      delivered.current = state.preview.token;
      onPreview(state.preview);
    }
  });

  const error = fileError ?? state.error ?? null;

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const problem = pdfFileProblem(file);
    setFileError(problem);
    if (problem) {
      input.value = '';
      return;
    }
    input.form?.requestSubmit();
  }

  function retry() {
    setFileError(null);
    if (inputRef.current) {
      inputRef.current.value = '';
      inputRef.current.click();
    }
  }

  return (
    <form action={formAction} className="stack picker" aria-busy={pending}>
      <label className={`dropzone${pending ? ' is-busy' : ''}`}>
        <svg className="dropzone-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
          <path d="M12 17v-6" />
          <path d="m9.5 13.5 2.5-2.5 2.5 2.5" />
        </svg>
        <span className="dropzone-title">Elegir PDF del horario</span>
        <span className="dropzone-hint">Máximo 2 MB. Se lee al elegirlo y no se guarda.</span>
        <input
          ref={inputRef}
          type="file"
          name="file"
          accept="application/pdf,.pdf"
          required
          disabled={pending}
          onChange={onPick}
          aria-label="Elegir PDF del horario"
        />
      </label>
      <noscript>
        <button type="submit" className="btn primary">
          Subir PDF
        </button>
      </noscript>

      <div role="status" aria-live="polite" className="picker-status">
        {pending && (
          <p className="loading-text">
            <span className="spinner" aria-hidden="true" />
            Leyendo tu horario…
          </p>
        )}
      </div>
      {pending && <ScheduleSkeleton />}

      {error && !pending && (
        <div className="stack">
          <p className="alert" role="alert">
            {error}
          </p>
          <div className="actions">
            <button type="button" className="btn primary" onClick={retry}>
              Intentar de nuevo
            </button>
          </div>
        </div>
      )}
      {onCancel && (
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={pending}>
            Cancelar
          </button>
        </div>
      )}
    </form>
  );
}
