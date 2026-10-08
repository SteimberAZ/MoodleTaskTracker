import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { getNtfyStatus } from '@/lib/ntfy-status';
import { ACTIVATE_NOTIFICATIONS_HREF } from '@/lib/push-setup';
import { resolveNtfyServer } from '@/lib/random';
import NtfyToggle, { NtfyConfirm, RegenerateTopicForm } from '@/components/NtfyToggle';
import TestPushForm from '@/components/TestPushForm';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Mi cuenta' };

export default async function AccountPage() {
  const user = await requireUser();
  const subscribeUrl = `${resolveNtfyServer(process.env.NTFY_SERVER)}/${encodeURIComponent(user.ntfy_topic)}`;
  const ntfy = await getNtfyStatus(user.id);

  return (
    <>
      <header className="page-head">
        <h1>Mi cuenta</h1>
      </header>

      <section className="card item" aria-labelledby="profile-title">
        <h2 id="profile-title" className="card-title">Perfil</h2>
        <dl className="meta">
          {user.fullname && <div><dt>Nombre</dt><dd>{user.fullname}</dd></div>}
          <div><dt>Usuario de Moodle</dt><dd>{user.username}</dd></div>
        </dl>
      </section>

      <section className="card item" aria-labelledby="push-title">
        <h2 id="push-title" className="card-title">Notificaciones en este dispositivo</h2>
        <p className="muted">Recibe los avisos de tus tareas en el teléfono o la computadora, aunque la app esté cerrada.</p>
        <div className="actions">
          <Link href={ACTIVATE_NOTIFICATIONS_HREF} className="btn primary">Configurar notificaciones</Link>
        </div>
      </section>

      <details className="help-box">
        <summary>Avanzado</summary>
        <section className="card item" aria-labelledby="ntfy-title">
          <h2 id="ntfy-title" className="card-title">Notificaciones (ntfy)</h2>
          <p className="muted">
            Instala la app ntfy, toca + y suscríbete a este tema. Es privado: no lo compartas.
          </p>
          <NtfyToggle enabled={ntfy.enabled} />
          {ntfy.confirmationSupported && <NtfyConfirm confirmedAt={ntfy.confirmedAt} />}
          <dl className="meta">
            <div><dt>Tu tema</dt><dd className="mono">{user.ntfy_topic}</dd></div>
            <div>
              <dt>Enlace para suscribirte</dt>
              <dd>
                <a href={subscribeUrl} target="_blank" rel="noopener noreferrer" className="mono">
                  {subscribeUrl}
                  <span className="sr-only"> (se abre en otra pestaña)</span>
                </a>
              </dd>
            </div>
          </dl>
          <TestPushForm />
          <RegenerateTopicForm />
          <p className="muted small">Al regenerar el tema debes volver a suscribirte con el nuevo enlace.</p>
        </section>
      </details>
    </>
  );
}
