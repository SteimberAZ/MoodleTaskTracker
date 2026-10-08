import { parseScheduleEntries } from './schedule-entries';
import { verifySchedulePreview } from './schedule-token';
import type { SchedulePeriod } from './class-schedule';
import type { ScheduleClass } from './sga-schedule';

export type ImportSave = { ok: true; classes: ScheduleClass[]; period: SchedulePeriod } | { ok: false; error: string };

/**
 * Save path for a freshly imported PDF. The edited entries are accepted only together with the signed upload
 * token issued to this very user (not expired, not tampered); the period comes from the token, never from the
 * browser. Entries are validated strictly on top of that.
 */
export async function resolveImportSave(
  secret: string | undefined,
  userId: string,
  token: unknown,
  entries: unknown,
  nowMs: number = Date.now(),
): Promise<ImportSave> {
  const data = await verifySchedulePreview(secret, userId, token, nowMs);
  if (!data) return { ok: false, error: 'La vista previa expiró. Sube el PDF otra vez.' };
  const parsed = parseScheduleEntries(entries);
  if (!parsed.ok) return parsed;
  return { ok: true, classes: parsed.classes, period: { label: data.periodLabel, end: data.periodEnd } };
}
