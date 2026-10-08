'use client';

interface Props {
  action: () => Promise<void>;
  label: string;
  message: string;
  danger?: boolean;
  disabled?: boolean;
}

/** Form button that asks for confirmation before running a server action. */
export default function ConfirmButton({ action, label, message, danger = false, disabled = false }: Props) {
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(message)) event.preventDefault();
      }}
    >
      <button type="submit" className={`btn${danger ? ' danger' : ''}`} disabled={disabled}>
        {label}
      </button>
    </form>
  );
}
