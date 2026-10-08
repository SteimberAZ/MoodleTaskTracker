export type IntervalUnit = 'minutes' | 'hours' | 'days';

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 365 * 24 * 60;

const UNIT_MINUTES: Record<IntervalUnit, number> = { minutes: 1, hours: 60, days: 1440 };

export function isIntervalUnit(value: string): value is IntervalUnit {
  return value === 'minutes' || value === 'hours' || value === 'days';
}

export function toIntervalMinutes(amount: number, unit: IntervalUnit): number {
  return amount * UNIT_MINUTES[unit];
}

/** Splits stored minutes back into the largest unit that divides them evenly (for the edit form). */
export function splitInterval(minutes: number): { amount: number; unit: IntervalUnit } {
  if (minutes % 1440 === 0) return { amount: minutes / 1440, unit: 'days' };
  if (minutes % 60 === 0) return { amount: minutes / 60, unit: 'hours' };
  return { amount: minutes, unit: 'minutes' };
}

/** Spanish description of the frequency: "cada 2 horas", "cada día", "cada 30 minutos". */
export function formatInterval(minutes: number): string {
  const { amount, unit } = splitInterval(minutes);
  if (unit === 'days') return amount === 1 ? 'cada día' : `cada ${amount} días`;
  if (unit === 'hours') return amount === 1 ? 'cada hora' : `cada ${amount} horas`;
  return amount === 1 ? 'cada minuto' : `cada ${amount} minutos`;
}

export interface NextFireInput {
  startsAt: Date;
  endsAt: Date;
  intervalMinutes: number;
  now: Date;
}

export interface NextFireResult {
  nextFireAt: Date;
  /** False when the next fire would fall after `endsAt`, i.e. the reminder is over. */
  active: boolean;
}

/**
 * Next fire time: `startsAt` while it is still in the future, otherwise the first
 * `startsAt + k * interval` strictly after `now`. Inactive when that is past `endsAt`.
 */
export function computeNextFire({ startsAt, endsAt, intervalMinutes, now }: NextFireInput): NextFireResult {
  const intervalMs = intervalMinutes * 60_000;
  let next: number;
  if (startsAt.getTime() > now.getTime()) {
    next = startsAt.getTime();
  } else {
    const elapsed = now.getTime() - startsAt.getTime();
    next = startsAt.getTime() + (Math.floor(elapsed / intervalMs) + 1) * intervalMs;
  }
  return { nextFireAt: new Date(next), active: next <= endsAt.getTime() };
}

export type ReminderStatus = 'activo' | 'pausado' | 'finalizado';

export function reminderStatus(r: { active: boolean; ends_at: string }, now: Date): ReminderStatus {
  if (new Date(r.ends_at).getTime() <= now.getTime()) return 'finalizado';
  return r.active ? 'activo' : 'pausado';
}
