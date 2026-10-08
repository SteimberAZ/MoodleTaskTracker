'use client';

export default function DisconnectButton({ action }: { action: () => Promise<void> }) {
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm('¿Desconectar Moodle? Se eliminará el token guardado.')) event.preventDefault();
      }}
    >
      <button type="submit" className="btn danger">Desconectar</button>
    </form>
  );
}
