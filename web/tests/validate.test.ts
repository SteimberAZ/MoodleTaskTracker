import { describe, expect, it } from 'vitest';
import { validateReminderForm, type ReminderFormInput } from '@/lib/validate';

const valid: ReminderFormInput = {
  title: ' Tomar agua ',
  message: '',
  amount: '2',
  unit: 'hours',
  startsAt: '2026-10-07T08:00',
  endsAt: '2026-10-08T08:00',
};

describe('validateReminderForm', () => {
  it('accepts a valid form and normalizes values', () => {
    const r = validateReminderForm(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe('Tomar agua');
      expect(r.value.message).toBeNull();
      expect(r.value.intervalMinutes).toBe(120);
      expect(r.value.startsAt.toISOString()).toBe('2026-10-07T13:00:00.000Z');
    }
  });

  it('requires a title', () => {
    const r = validateReminderForm({ ...valid, title: '  ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.title).toBeDefined();
  });

  it('enforces the 5 minute minimum on the total interval', () => {
    expect(validateReminderForm({ ...valid, amount: '4', unit: 'minutes' }).ok).toBe(false);
    expect(validateReminderForm({ ...valid, amount: '5', unit: 'minutes' }).ok).toBe(true);
  });

  it('rejects non-integer or zero amounts and unknown units', () => {
    expect(validateReminderForm({ ...valid, amount: '1.5' }).ok).toBe(false);
    expect(validateReminderForm({ ...valid, amount: '0' }).ok).toBe(false);
    expect(validateReminderForm({ ...valid, unit: 'weeks' }).ok).toBe(false);
  });

  it('requires end after start', () => {
    const r = validateReminderForm({ ...valid, endsAt: valid.startsAt });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.endsAt).toBeDefined();
  });

  it('rejects invalid dates', () => {
    const r = validateReminderForm({ ...valid, startsAt: '', endsAt: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toEqual(expect.arrayContaining(['startsAt', 'endsAt']));
  });
});
