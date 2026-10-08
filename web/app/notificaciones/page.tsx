import { requireUser } from '@/lib/auth';
import { parsePage } from '@/lib/pagination';
import { listHistoryPage } from '@/lib/notification-history';
import { parseHistoryFilter } from '@/lib/notification-log';
import PushSetup from '@/components/PushSetup';
import NotificationHistory from '@/components/NotificationHistory';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function NotificationsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const params = await searchParams;
  const filter = parseHistoryFilter(params.hk);
  const history = await listHistoryPage(user.id, filter, parsePage(params.hp)).catch(() => null);

  return (
    <>
      <header className="page-head">
        <h1>Activa las notificaciones</h1>
        <p className="muted">Recibe avisos de tus tareas y recordatorios en este dispositivo, aunque la app esté cerrada.</p>
      </header>
      {/* The public VAPID key is read on the server and handed down, so the page never depends on a client-side env inline. */}
      <PushSetup vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY} />
      <NotificationHistory filter={filter} result={history} now={new Date()} />
      <p className="muted small">Horas en Ecuador (UTC-5).</p>
    </>
  );
}
