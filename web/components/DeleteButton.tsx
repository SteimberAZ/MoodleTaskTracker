'use client';

interface Props {
  action: () => Promise<void>;
  title: string;
}

export default function DeleteButton({ action, title }: Props) {
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(`¿Eliminar el recordatorio "${title}"? Esta acción no se puede deshacer.`)) {
          event.preventDefault();
        }
      }}
    >
      <button type="submit" className="btn danger">Eliminar</button>
    </form>
  );
}
