import { requireUser } from '@/lib/auth';
import PushSetup from '@/components/PushSetup';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  await requireUser();
  return (
    <>
      <header className="page-head">
        <h1>Activa las notificaciones</h1>
        <p className="muted">Recibe avisos de tus tareas y recordatorios en este dispositivo, aunque la app esté cerrada.</p>
      </header>
      {/* The public VAPID key is read on the server and handed down, so the page never depends on a client-side env inline. */}
      <PushSetup vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY} />
    </>
  );
}
