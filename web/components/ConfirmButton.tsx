'use client';

import SubmitButton from './SubmitButton';

interface Props {
  action: () => Promise<void>;
  label: string;
  message: string;
  danger?: boolean;
  disabled?: boolean;
  /** Shown while the action runs (defaults to "Procesando…"). */
  pendingLabel?: string;
}

/** Form button that asks for confirmation before running a server action. */
export default function ConfirmButton({
  action,
  label,
  message,
  danger = false,
  disabled = false,
  pendingLabel = 'Procesando…',
}: Props) {
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(message)) event.preventDefault();
      }}
    >
      <SubmitButton className={`btn${danger ? ' danger' : ''}`} disabled={disabled} pendingLabel={pendingLabel}>
        {label}
      </SubmitButton>
    </form>
  );
}
