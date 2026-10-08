import { describe, expect, it } from 'vitest';
import { resolveImportSave } from '@/lib/schedule-save';
import { PREVIEW_TTL_MS, signSchedulePreview, type SchedulePreviewData } from '@/lib/schedule-token';
import type { ScheduleClass } from '@/lib/sga-schedule';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SECRET = 'test-secret';

const cls = (over: Partial<ScheduleClass> = {}): ScheduleClass => ({
  subject: 'MATERIA FICTICIA',
  level: 5,
  parallel: 'A',
  credits: 3,
  teacher: 'NOMBRE FICTICIO',
  department: null,
  weekday: 2,
  startTime: '07:00',
  endTime: '09:00',
  place: null,
  roomCode: null,
  roomType: null,
  floor: null,
  ...over,
});

const data: SchedulePreviewData = { periodLabel: 'SEPTIEMBRE 2026 - ENERO 2027', periodEnd: '2027-01-31', classes: [cls()] };
const EXPIRED = 'La vista previa expiró. Sube el PDF otra vez.';

describe('import save path', () => {
  it('accepts edited entries with a valid token and takes the period from the token', async () => {
    const token = await signSchedulePreview(SECRET, ME, data, 1_000);
    const edited = [cls({ subject: 'CORREGIDA', startTime: '08:00', endTime: '10:00' }), cls({ weekday: 5 })];
    const out = await resolveImportSave(SECRET, ME, token, edited, 2_000);
    expect(out).toEqual({
      ok: true,
      classes: [expect.objectContaining({ subject: 'CORREGIDA', startTime: '08:00' }), expect.objectContaining({ weekday: 5 })],
      period: { label: 'SEPTIEMBRE 2026 - ENERO 2027', end: '2027-01-31' },
    });
  });

  it('rejects an expired token', async () => {
    const token = await signSchedulePreview(SECRET, ME, data, 1_000);
    expect(await resolveImportSave(SECRET, ME, token, [cls()], 1_000 + PREVIEW_TTL_MS + 1)).toEqual({ ok: false, error: EXPIRED });
  });

  it('rejects a token issued to another user', async () => {
    const token = await signSchedulePreview(SECRET, OTHER, data, 1_000);
    expect(await resolveImportSave(SECRET, ME, token, [cls()], 2_000)).toEqual({ ok: false, error: EXPIRED });
  });

  it('rejects tampered, forged and missing tokens', async () => {
    const token = await signSchedulePreview(SECRET, ME, data, 1_000);
    const [payload, sig] = token.split('.');
    const body = { ...JSON.parse(Buffer.from(payload, 'base64url').toString()), end: '2099-12-31' };
    const forged = `${Buffer.from(JSON.stringify(body)).toString('base64url')}.${sig}`;
    for (const bad of [forged, `${payload}.${'0'.repeat(sig.length)}`, `${payload}.`, 'abc', '', null, undefined, 42]) {
      expect(await resolveImportSave(SECRET, ME, bad, [cls()], 2_000)).toEqual({ ok: false, error: EXPIRED });
    }
    expect(await resolveImportSave('another-secret', ME, token, [cls()], 2_000)).toEqual({ ok: false, error: EXPIRED });
    expect(await resolveImportSave(undefined, ME, token, [cls()], 2_000)).toEqual({ ok: false, error: EXPIRED });
  });

  it('still validates the entries strictly when the token is valid', async () => {
    const token = await signSchedulePreview(SECRET, ME, data, 1_000);
    const badInputs: unknown[] = [
      [],
      [cls({ weekday: 0 })],
      [cls({ startTime: '10:00', endTime: '09:00' })],
      [cls({ subject: 'A'.repeat(201) })],
      'nope',
      null,
      Array.from({ length: 61 }, () => cls()),
    ];
    for (const bad of badInputs) {
      const out = await resolveImportSave(SECRET, ME, token, bad, 2_000);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).not.toBe(EXPIRED);
    }
  });
});
