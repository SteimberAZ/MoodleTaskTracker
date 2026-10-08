import { describe, expect, it } from 'vitest';
import { PREVIEW_TTL_MS, signSchedulePreview, verifySchedulePreview, type SchedulePreviewData } from '@/lib/schedule-token';
import type { ScheduleClass } from '@/lib/sga-schedule';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SECRET = 'test-secret';

const cls: ScheduleClass = {
  subject: 'MATERIA FICTICIA',
  level: 5,
  parallel: 'A',
  credits: 3,
  teacher: 'NOMBRE FICTICIO',
  department: null,
  weekday: 2,
  startTime: '07:00',
  endTime: '09:00',
  place: 'FACULTAD DE CIENCIAS INFORMÁTICAS',
  roomCode: '1-59-1-03-LC',
  roomType: 'LABORATORIO',
  floor: '1',
};
const data: SchedulePreviewData = { periodLabel: 'SEPTIEMBRE 2026 - ENERO 2027', periodEnd: '2027-01-31', classes: [cls] };

describe('schedule preview token', () => {
  it('round-trips the parsed schedule for the same user', async () => {
    const token = await signSchedulePreview(SECRET, ME, data, 1_000);
    expect(await verifySchedulePreview(SECRET, ME, token, 2_000)).toEqual(data);
  });

  it('is bound to the user it was issued to', async () => {
    const token = await signSchedulePreview(SECRET, ME, data, 1_000);
    expect(await verifySchedulePreview(SECRET, OTHER, token, 2_000)).toBeNull();
  });

  it('expires', async () => {
    const token = await signSchedulePreview(SECRET, ME, data, 1_000);
    expect(await verifySchedulePreview(SECRET, ME, token, 1_000 + PREVIEW_TTL_MS - 1)).not.toBeNull();
    expect(await verifySchedulePreview(SECRET, ME, token, 1_000 + PREVIEW_TTL_MS + 1)).toBeNull();
  });

  it('rejects a different secret, tampering and garbage', async () => {
    const token = await signSchedulePreview(SECRET, ME, data, 1_000);
    expect(await verifySchedulePreview('other-secret', ME, token, 2_000)).toBeNull();
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), uid: OTHER }), 'utf8').toString('base64url');
    expect(await verifySchedulePreview(SECRET, OTHER, `${forged}.${sig}`, 2_000)).toBeNull();
    for (const bad of ['', 'abc', 'a.b.c', `${payload}.`, null, undefined, 42, {}]) {
      expect(await verifySchedulePreview(SECRET, ME, bad, 2_000)).toBeNull();
    }
    expect(await verifySchedulePreview(undefined, ME, token, 2_000)).toBeNull();
  });

  it('validates the classes again after verifying the signature', async () => {
    const bad = { ...data, classes: [{ ...cls, weekday: 9 }] };
    const token = await signSchedulePreview(SECRET, ME, bad, 1_000);
    expect(await verifySchedulePreview(SECRET, ME, token, 2_000)).toBeNull();
  });
});
