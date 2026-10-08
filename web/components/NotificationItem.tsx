import Link from 'next/link';
import {
  bodyIsLong,
  channelBadges,
  kindLabel,
  notificationDomId,
  notificationTimeLabel,
  relativeLabel,
  safeNotificationHref,
  type NotificationLogRow,
} from '@/lib/notification-log';
import { BellIcon, BellOffIcon, CalendarIcon, ClockIcon, TasksIcon } from './Icons';

function KindIcon({ kind }: { kind: string }) {
  switch (kind) {
    case 'task':
      return <TasksIcon />;
    case 'reminder':
      return <ClockIcon />;
    case 'class':
      return <CalendarIcon />;
    case 'status':
      return <BellOffIcon />;
    default:
      return <BellIcon />;
  }
}

/**
 * One compact history entry: kind icon, title, body, time and per-channel outcome. Links to its page when the stored path is safe.
 * `focused` marks the entry the user opened from a notification (`?n=`); every entry has the DOM id `n-<uuid>`.
 */
export default function NotificationItem({ row, now, focused = false }: { row: NotificationLogRow; now: Date; focused?: boolean }) {
  const href = safeNotificationHref(row.url);
  const failed = row.status === 'failed';
  const long = bodyIsLong(row.body);
  const badges = channelBadges(row);
  const relative = relativeLabel(row.created_at, now);
  const time = notificationTimeLabel(row.created_at, now);
  const parsed = new Date(row.created_at);
  const title = row.title || 'Aviso';

  return (
    <li id={notificationDomId(row.id)} className={`card hist-item${failed ? ' is-failed' : ''}${focused ? ' is-focused' : ''}`}
        aria-current={focused ? 'true' : undefined}>
      <span className="hist-icon" aria-hidden="true">
        <KindIcon kind={row.kind} />
      </span>
      <div className="hist-main">
        <h3 className="hist-title">
          {href ? (
            <Link href={href} title={title}>
              {title}
            </Link>
          ) : (
            title
          )}
        </h3>
        {row.body && <p className="hist-body">{row.body}</p>}
        {row.body && long && (
          <details className="hist-more">
            <summary>
              <span className="more-closed">Ver más</span>
              <span className="more-open">Ver menos</span>
            </summary>
            <p className="hist-body-full">{row.body}</p>
          </details>
        )}
        <p className="hist-meta">
          <span>{kindLabel(row.kind)}</span>
          <span aria-hidden="true">·</span>
          {Number.isNaN(parsed.getTime()) ? <span>{time}</span> : <time dateTime={parsed.toISOString()}>{time}</time>}
          {relative && (
            <>
              <span aria-hidden="true">·</span>
              <span>{relative}</span>
            </>
          )}
        </p>
        {badges.length > 0 && (
          <ul className="hist-badges plain-list" aria-label="Entrega">
            {badges.map((b) => (
              <li key={b.key} className={`badge ${b.tone}`}>
                {b.srText ? (
                  <>
                    <span aria-hidden="true">{b.text}</span>
                    <span className="sr-only">{b.srText}</span>
                  </>
                ) : (
                  b.text
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
