import type { ReactNode } from 'react';

/**
 * Save / edit / cancel actions of a schedule draft. On phones it sticks to the bottom of the viewport above the
 * tab bar (safe-area aware, see `.action-bar`); on wide screens it sits inline below the content.
 */
export default function ScheduleActionBar({
  busy,
  onSave,
  onCancel,
  secondary,
}: {
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
  /** The middle button: "Editar" in the preview, "Listo" in the editor. */
  secondary: { label: string; onClick: () => void };
}): ReactNode {
  return (
    <div className="action-bar" role="group" aria-label="Acciones del horario">
      <button type="button" className="btn primary" onClick={onSave} disabled={busy}>
        {busy ? 'Guardando…' : 'Guardar horario'}
      </button>
      <button type="button" className="btn" onClick={secondary.onClick} disabled={busy}>
        {secondary.label}
      </button>
      <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
        Cancelar
      </button>
    </div>
  );
}
