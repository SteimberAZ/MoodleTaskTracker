import { requireUser } from '@/lib/auth';
import { resolveNtfyServer } from '@/lib/random';
import { regenerateTopic } from './actions';
import Nav from '@/components/Nav';
import ConfirmButton from '@/components/ConfirmButton';
import TestPushForm from '@/components/TestPushForm';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const user = await requireUser();
  const subscribeUrl = `${resolveNtfyServer(process.env.NTFY_SERVER)}/${encodeURIComponent(user.ntfy_topic)}`;

  return (
    <>
      <Nav isAdmin={user.is_admin} />
      <header className="topbar">
        <h1>Mi cuenta</h1>
      </header>

      <section className="card item" aria-labelledby="profile-title">
        <h2 id="profile-title">Perfil</h2>
        <dl className="meta">
          {user.fullname && <div><dt>Nombre</dt><dd>{user.fullname}</dd></div>}
          <div><dt>Usuario de Moodle</dt><dd>{user.username}</dd></div>
        </dl>
      </section>

      <section className="card item" aria-labelledby="ntfy-title">
        <h2 id="ntfy-title">Notificaciones (ntfy)</h2>
        <p className="muted">
          Instala la app ntfy, toca + y suscríbete a este tema. Es privado: no lo compartas.
        </p>
        <dl className="meta">
          <div><dt>Tu tema</dt><dd className="mono">{user.ntfy_topic}</dd></div>
          <div>
            <dt>Enlace para suscribirte</dt>
            <dd>
              <a href={subscribeUrl} target="_blank" rel="noopener noreferrer" className="mono">{subscribeUrl}</a>
            </dd>
          </div>
        </dl>
        <TestPushForm />
        <div className="actions">
          <ConfirmButton
            action={regenerateTopic}
            label="Regenerar tema"
            message="¿Regenerar tu tema? Dejarás de recibir avisos en el tema actual y tendrás que volver a suscribirte al nuevo."
            danger
          />
        </div>
        <p className="muted small">Al regenerar el tema debes volver a suscribirte con el nuevo enlace.</p>
      </section>
    </>
  );
}
