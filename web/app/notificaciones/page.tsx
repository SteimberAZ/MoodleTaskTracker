import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { parsePage } from '@/lib/pagination';
import { getHistoryEntry, listHistoryPage } from '@/lib/notification-history';
import { parseHistoryFilter, parseNotificationParam } from '@/lib/notification-log';
import { getNtfyStatus } from '@/lib/ntfy-status';
import { ACTIVATE_NOTIFICATIONS_HREF, parseActivarParam } from '@/lib/push-setup';
import { countUserPushDevices } from '@/lib/push-subscriptions';
import PushSetup from '@/components/PushSetup';
import NotificationHistory from '@/components/NotificationHistory';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Notificaciones' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function NotificationsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const params = await searchParams;
  const filter = parseHistoryFilter(params.hk);
  const activar = parseActivarParam(params.activar);
  // `?n=<uuid>`: the notification the user tapped. Anything that is not a uuid is ignored.
  const focusId = parseNotificationParam(params.n);
  const [history, entry, devices, ntfy] = await Promise.all([
    listHistoryPage(user.id, filter, parsePage(params.hp)).catch(() => null),
    // undefined (not null) when the read fails: the page then shows nothing instead of a wrong "ya no está".
    focusId ? getHistoryEntry(user.id, focusId).catch(() => undefined) : Promise.resolve(undefined),
    // null when it cannot be read: no notice then, rather than a false "no devices".
    countUserPushDevices(user.id),
    getNtfyStatus(user.id),
  ]);
  // Unconfirmed ntfy does not count as delivered, so it never hides the missing push devices.
  const ntfyUnconfirmed = ntfy.enabled && ntfy.confirmationSupported && !ntfy.confirmedAt;

  return (
    <>
      <header className="page-head">
        <h1>Notificaciones</h1>
        <p className="muted">Recibe avisos de tus tareas y recordatorios en este dispositivo, aunque la app esté cerrada.</p>
      </header>
      {devices === 0 && (
        <aside className="banner" aria-labelledby="no-devices-title">
          <div className="banner-text">
            <strong id="no-devices-title">No tienes dispositivos con avisos activos</strong>
            <span>
              {ntfyUnconfirmed
                ? 'Aunque tengas ntfy, sin confirmarlo no cuenta como entregado. Activa las notificaciones en este dispositivo para no perder avisos.'
                : 'Activa las notificaciones en este dispositivo para no perder avisos.'}
            </span>
          </div>
          <Link href={ACTIVATE_NOTIFICATIONS_HREF} className="btn primary">Activar</Link>
        </aside>
      )}
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
