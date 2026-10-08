import { requireUser } from '@/lib/auth';
import { parsePage } from '@/lib/pagination';
import { getHistoryEntry, listHistoryPage } from '@/lib/notification-history';
import { parseHistoryFilter, parseNotificationParam } from '@/lib/notification-log';
import { parseActivarParam } from '@/lib/push-setup';
import PushSetup from '@/components/PushSetup';
import NotificationHistory from '@/components/NotificationHistory';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function NotificationsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const params = await searchParams;
  const filter = parseHistoryFilter(params.hk);
  const activar = parseActivarParam(params.activar);
  // `?n=<uuid>`: the notification the user tapped. Anything that is not a uuid is ignored.
  const focusId = parseNotificationParam(params.n);
  const [history, entry] = await Promise.all([
    listHistoryPage(user.id, filter, parsePage(params.hp)).catch(() => null),
    // undefined (not null) when the read fails: the page then shows nothing instead of a wrong "ya no está".
    focusId ? getHistoryEntry(user.id, focusId).catch(() => undefined) : Promise.resolve(undefined),
  ]);

  return (
    <>
      <header className="page-head">
        <h1>Activa las notificaciones</h1>
        <p className="muted">Recibe avisos de tus tareas y recordatorios en este dispositivo, aunque la app esté cerrada.</p>
      </header>
      {/* The public VAPID key is read on the server and handed down, so the page never depends on a client-side env inline. */}
      <PushSetup
        vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY}
        activar={activar}
        focusedNotification={focusId !== null}
      />
      <NotificationHistory
        filter={filter}
        result={history}
        now={new Date()}
        focus={focusId ? { id: focusId, row: entry } : null}
      />
      <p className="muted small">Horas en Ecuador (UTC-5).</p>
    </>
  );
}
