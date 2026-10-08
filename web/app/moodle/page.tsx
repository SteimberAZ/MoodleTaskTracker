import Link from 'next/link';
import { requireSession } from '@/lib/auth';
import { getCredentialStatus } from '@/lib/credentials';
import { isDisconnected, type CredentialStatus } from '@/lib/moodle';
import { formatGuayaquil } from '@/lib/time';
import { disconnectMoodle } from '@/app/actions';
import MoodleConnectForm from '@/components/MoodleConnectForm';
import DisconnectButton from '@/components/DisconnectButton';

export const dynamic = 'force-dynamic';

export default async function MoodlePage() {
  await requireSession();
  let status: CredentialStatus | null = null;
  let loadError = false;
  try {
    status = await getCredentialStatus();
  } catch {
    loadError = true;
  }
  const broken = status ? isDisconnected(status) : false;

  return (
    <>
      <header className="topbar">
        <h1>Conectar Moodle</h1>
        <div className="actions">
          <Link href="/" className="btn">Volver</Link>
        </div>
      </header>

      {loadError && <p className="alert" role="alert">No se pudo cargar el estado de la conexión.</p>}
      {broken && (
        <p className="alert" role="alert">Moodle desconectado: vuelve a conectar.</p>
      )}

      {status && (
        <section className="card item" aria-labelledby="status-title">
          <div className="item-head">
            <h2 id="status-title">Conexión actual</h2>
            <span className={`badge ${broken ? 'finalizado' : 'activo'}`}>{broken ? 'con error' : 'conectado'}</span>
          </div>
          <dl className="meta">
            <div><dt>Usuario</dt><dd>{status.username}</dd></div>
            {status.fullname && <div><dt>Nombre</dt><dd>{status.fullname}</dd></div>}
            <div><dt>Conectado</dt><dd>{formatGuayaquil(status.connected_at)}</dd></div>
            {status.last_error_at && <div><dt>Último error</dt><dd>{formatGuayaquil(status.last_error_at)}</dd></div>}
          </dl>
          <div className="actions">
            <DisconnectButton action={disconnectMoodle} />
          </div>
        </section>
      )}

      <h2 className="section-title">{status ? 'Volver a conectar' : 'Iniciar sesión en Moodle'}</h2>
      <MoodleConnectForm reconnect={!!status} />
    </>
  );
}
