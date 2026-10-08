import { formatGuayaquilShort } from './time';

/**
 * Pure helpers for the "Avisos automáticos" card of the task detail page.
 *
 * The VPS worker (notifier.py) sends these alerts on its own: `new` when a task is first seen, then
 * `3d`, `2d`, `1d` and `8h` before the deadline. When a smaller window is reached first, the larger
 * milestones are recorded together with it without sending anything, so they never fire late.
 * The worker mirrors every recorded milestone to `moodle_task_milestones`.
 */
export type MilestoneKey = 'new' | '3d' | '2d' | '1d' | '8h';

/** Milestone -> `sent_at` (Unix seconds, null when the mirror has no timestamp). Absent key = no record. */
export type SentMap = Partial<Record<MilestoneKey, number | null>>;

export type AutoReminderState = 'sent' | 'skipped' | 'pending' | 'stopped' | 'unknown';

export interface AutoReminderItem {
  key: MilestoneKey;
  label: string;
  /** Scheduled time in Unix seconds; null for the `new` item (it fires when the task is first seen). */
  at: number | null;
  state: AutoReminderState;
  /** When the worker recorded it (Unix seconds), when known. */
  sentAt: number | null;
}

const HOUR = 3600;

/** Timed milestones, earliest first. Offsets mirror the thresholds in `process_milestones`. */
const TIMED: readonly { key: Exclude<MilestoneKey, 'new'>; label: string; offset: number }[] = [
  { key: '3d', label: '3 días antes', offset: 72 * HOUR },
  { key: '2d', label: '2 días antes', offset: 48 * HOUR },
  { key: '1d', label: '1 día antes', offset: 24 * HOUR },
  { key: '8h', label: '8 horas antes', offset: 8 * HOUR },
];

export const NEW_TASK_LABEL = 'Aviso de tarea nueva';

const KEYS: readonly string[] = ['new', '3d', '2d', '1d', '8h'];

/** Turns `moodle_task_milestones` rows into a `SentMap`; malformed rows are ignored. */
export function parseMilestoneRows(rows: unknown): SentMap {
  const map: SentMap = {};
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { milestone, sent_at: sentAt } = row as { milestone?: unknown; sent_at?: unknown };
    if (typeof milestone !== 'string' || !KEYS.includes(milestone)) continue;
    const n = typeof sentAt === 'number' ? sentAt : typeof sentAt === 'string' && sentAt.trim() ? Number(sentAt) : NaN;
    map[milestone as MilestoneKey] = Number.isFinite(n) ? n : null;
  }
  return map;
}

/**
 * Ordered schedule: the `new` item followed by 3d, 2d, 1d and 8h.
 *
 * - record exists            -> `sent`, unless it was recorded once a smaller window had already started
 *                               (the worker pre-records larger milestones without sending): then `skipped`
 * - no record, submitted/muted -> `stopped` (the worker ignores these tasks)
 * - no record, time reached  -> `skipped` (<= now, same inclusive boundary as the worker)
 * - no record, in the future -> `pending`
 *
 * `sentMap` null means the milestones could not be read: every item is `unknown` (schedule only).
 */
export function automaticReminderSchedule(
  dueTs: number,
  nowTs: number,
  sentMap: SentMap | null,
  flags: { submitted: boolean; muted: boolean },
): AutoReminderItem[] {
  const stopped = flags.submitted || flags.muted;

  const resolve = (key: MilestoneKey, label: string, at: number | null, nextOffset: number | null): AutoReminderItem => {
    const item = (state: AutoReminderState, sentAt: number | null = null): AutoReminderItem => ({
      key,
      label,
      at,
      state,
      sentAt,
    });
    if (sentMap === null) return item('unknown');
    if (key in sentMap) {
      const sentAt = sentMap[key] ?? null;
      const early = nextOffset !== null && sentAt !== null && sentAt >= dueTs - nextOffset;
      return item(early ? 'skipped' : 'sent', sentAt);
    }
    if (stopped) return item('stopped');
    if (at === null || at <= nowTs) return item('skipped');
    return item('pending');
  };

  return [
    resolve('new', NEW_TASK_LABEL, null, null),
    ...TIMED.map((m, i) => resolve(m.key, m.label, dueTs - m.offset, TIMED[i + 1]?.offset ?? null)),
  ];
}

/** Status text of one item, in Ecuador time. */
export function describeAutoReminder(item: AutoReminderItem): string {
  switch (item.state) {
    case 'sent':
      return item.sentAt !== null ? `Enviado ${formatGuayaquilShort(item.sentAt)}` : 'Enviado';
    case 'skipped':
      return 'No enviado';
    case 'stopped':
      return 'Detenido';
    case 'pending':
      return `Programado ${formatGuayaquilShort(item.at as number)}`;
    default:
      return item.at !== null ? `Previsto ${formatGuayaquilShort(item.at)}` : 'Sin información';
  }
}
