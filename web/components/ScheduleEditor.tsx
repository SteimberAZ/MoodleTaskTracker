'use client';

import { useEffect, useRef, useState, type Dispatch } from 'react';
import { MAX_SCHEDULE_ENTRIES, WEEKDAY_NAMES } from '@/lib/class-schedule';
import { FIELD_LIMITS, type EntryErrors, type TextField } from '@/lib/schedule-entries';
import type { EditorAction, EditorEntry, EditorValidation } from '@/lib/schedule-editor';
import LiveStatus from './LiveStatus';

/** Id of the editor heading: ScheduleWorkspace focuses it when the edit step opens. */
export const SCHEDULE_EDIT_TITLE_ID = 'schedule-edit-title';
const removeButtonId = (key: string): string => `${key}-remove`;

function TextInput({
  entry,
  field,
  label,
  error,
  dispatch,
}: {
  entry: EditorEntry;
  field: TextField;
  label: string;
  error?: string;
  dispatch: Dispatch<EditorAction>;
}) {
  const id = `${entry.key}-${field}`;
  return (
    <div className="edit-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        value={entry[field]}
        maxLength={FIELD_LIMITS[field]}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => dispatch({ type: 'update', key: entry.key, patch: { [field]: e.target.value } })}
      />
      {error && (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

function EntryCard({
  entry,
  index,
  errors,
  dispatch,
  onRemove,
}: {
  entry: EditorEntry;
  index: number;
  errors: EntryErrors;
  dispatch: Dispatch<EditorAction>;
  onRemove: (key: string, index: number) => void;
}) {
  const timeField = (field: 'startTime' | 'endTime', label: string) => {
    const id = `${entry.key}-${field}`;
    const error = errors[field];
    return (
      <div className="edit-field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          type="time"
          value={entry[field]}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => dispatch({ type: 'update', key: entry.key, patch: { [field]: e.target.value } })}
        />
        {error && (
          <p id={`${id}-error`} className="field-error">
            {error}
          </p>
        )}
      </div>
    );
  };
  const small = (field: TextField, label: string) => (
    <TextInput entry={entry} field={field} label={label} error={errors[field]} dispatch={dispatch} />
  );

  return (
    <li className="edit-card card">
      <div className="edit-card-head">
        <h3>Clase {index + 1}</h3>
        <button
          type="button"
          id={removeButtonId(entry.key)}
          className="btn danger"
          onClick={() => onRemove(entry.key, index)}
          aria-label={`Eliminar clase ${index + 1}${entry.subject.trim() ? `: ${entry.subject.trim()}` : ''}`}
        >
          Eliminar
        </button>
      </div>
      <div className="edit-grid">
        {small('subject', 'Materia')}
        <div className="edit-pair">
          {small('parallel', 'Paralelo')}
          <div className="edit-field">
            <label htmlFor={`${entry.key}-weekday`}>Día</label>
            <select
              id={`${entry.key}-weekday`}
              value={entry.weekday}
              aria-invalid={errors.weekday ? true : undefined}
              aria-describedby={errors.weekday ? `${entry.key}-weekday-error` : undefined}
              onChange={(e) => dispatch({ type: 'update', key: entry.key, patch: { weekday: Number(e.target.value) } })}
            >
              {WEEKDAY_NAMES.slice(1).map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </select>
            {errors.weekday && (
              <p id={`${entry.key}-weekday-error`} className="field-error">
                {errors.weekday}
              </p>
            )}
          </div>
        </div>
        <div className="edit-pair">
          {timeField('startTime', 'Inicio')}
          {timeField('endTime', 'Fin')}
        </div>
        {small('teacher', 'Docente')}
        {small('place', 'Lugar')}
        {small('roomType', 'Tipo de aula')}
        <div className="edit-pair">
          {small('roomCode', 'Código del aula')}
          {small('floor', 'Piso')}
        </div>
      </div>
    </li>
  );
}

/**
 * Editable list of schedule entries (before saving). Errors are shown after the first save/"Listo" attempt
 * (`showErrors`) and stay live while the user fixes them.
 */
export default function ScheduleEditor({
  entries,
  dispatch,
  validation,
  showErrors,
}: {
  entries: EditorEntry[];
  dispatch: Dispatch<EditorAction>;
  validation: EditorValidation;
  showErrors: boolean;
}) {
  const counter = useRef(0);
  const addRef = useRef<HTMLButtonElement>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  /** Where focus goes after "Eliminar": another card's Eliminar button, or "Agregar clase" (null). */
  const [focusAfterRemove, setFocusAfterRemove] = useState<{ key: string | null } | null>(null);
  const [announcement, setAnnouncement] = useState('');

  // After "Agregar clase", move focus to the new entry's subject field.
  useEffect(() => {
    if (!focusKey) return;
    const input = document.getElementById(`${focusKey}-subject`);
    if (input) {
      input.focus();
      input.scrollIntoView({ block: 'center' });
    }
    setFocusKey(null);
  }, [focusKey, entries]);

  // After "Eliminar" the button is gone: focus the next card's Eliminar, else the previous one, else "Agregar clase".
  useEffect(() => {
    if (!focusAfterRemove) return;
    const target = focusAfterRemove.key ? document.getElementById(removeButtonId(focusAfterRemove.key)) : addRef.current;
    target?.focus();
    setFocusAfterRemove(null);
  }, [focusAfterRemove, entries]);

  function remove(key: string, index: number) {
    const neighbour = entries[index + 1] ?? entries[index - 1] ?? null;
    dispatch({ type: 'remove', key });
    setFocusAfterRemove({ key: neighbour?.key ?? null });
    const text = `Clase ${index + 1} eliminada`;
    // A trailing no-break space toggles on repeats, so removing "Clase 1" twice is announced twice.
    setAnnouncement((prev) => (prev === text ? `${text}\u00a0` : text));
  }

  const full = entries.length >= MAX_SCHEDULE_ENTRIES;
  function add() {
    const key = `n${++counter.current}`;
    dispatch({ type: 'add', key });
    setFocusKey(key);
  }

  return (
    <div className="stack">
      <div className="page-head">
        <h2 id={SCHEDULE_EDIT_TITLE_ID} tabIndex={-1}>
          Editar horario
        </h2>
        <p className="muted">Corrige los datos o elimina lo que no corresponda. Los cambios se aplican al guardar.</p>
      </div>
      {showErrors && validation.listError && (
        <p className="alert" role="alert">
          {validation.listError}
        </p>
      )}
      <ul className="edit-list plain-list">
        {entries.map((entry, index) => (
          <EntryCard
            key={entry.key}
            entry={entry}
            index={index}
            errors={showErrors ? (validation.byKey[entry.key] ?? {}) : {}}
            dispatch={dispatch}
            onRemove={remove}
          />
        ))}
      </ul>
      <div className="actions">
        <button type="button" className="btn" onClick={add} disabled={full} ref={addRef}>
          Agregar clase
        </button>
        {full && <span className="muted small">Máximo {MAX_SCHEDULE_ENTRIES} clases.</span>}
      </div>
      <LiveStatus message={announcement} />
    </div>
  );
}
