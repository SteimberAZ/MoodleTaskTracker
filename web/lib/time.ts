// America/Guayaquil is a fixed UTC-5 offset with no DST, so conversions are pure arithmetic
// and do not depend on the server timezone (Vercel runs in UTC).
export const GUAYAQUIL_OFFSET_MINUTES = -5 * 60;
const OFFSET_MS = GUAYAQUIL_OFFSET_MINUTES * 60_000;

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Parses a `datetime-local` value ("YYYY-MM-DDTHH:mm") entered in Guayaquil time into a UTC Date. */
export function guayaquilInputToDate(value: string): Date | null {
  const m = LOCAL_INPUT.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((p) => (p === undefined ? 0 : Number(p)));
  const utcMs = Date.UTC(y, mo - 1, d, h, mi, s) - OFFSET_MS;
  const check = new Date(utcMs + OFFSET_MS);
  // Reject overflowed dates such as 2026-02-31 or 25:00.
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    check.getUTCHours() !== h ||
    check.getUTCMinutes() !== mi
  ) {
    return null;
  }
  return new Date(utcMs);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Formats a UTC instant as a `datetime-local` value in Guayaquil time. */
export function dateToGuayaquilInput(date: Date): string {
  const g = new Date(date.getTime() + OFFSET_MS);
  return `${g.getUTCFullYear()}-${pad(g.getUTCMonth() + 1)}-${pad(g.getUTCDate())}T${pad(g.getUTCHours())}:${pad(g.getUTCMinutes())}`;
}

/** Short display of a Unix-seconds instant in Guayaquil time, without the year: "07/10 14:30". */
export function formatGuayaquilShort(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  if (!Number.isFinite(unixSeconds) || Number.isNaN(d.getTime())) return '—';
  const g = new Date(d.getTime() + OFFSET_MS);
  return `${pad(g.getUTCDate())}/${pad(g.getUTCMonth() + 1)} ${pad(g.getUTCHours())}:${pad(g.getUTCMinutes())}`;
}

/** Human display in Guayaquil time: "07/10/2026 14:30". */
export function formatGuayaquil(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '—';
  const g = new Date(d.getTime() + OFFSET_MS);
  return `${pad(g.getUTCDate())}/${pad(g.getUTCMonth() + 1)}/${g.getUTCFullYear()} ${pad(g.getUTCHours())}:${pad(g.getUTCMinutes())}`;
}
