import { describe, expect, it } from 'vitest';
import { validateReminderForm, type ReminderFormInput } from '@/lib/validate';

const valid: ReminderFormInput = {
  title: ' Tomar agua ',
  message: '',
  amount: '2',
  unit: 'hours',
  startsAt: '2026-10-07T08:00',
  endsAt: '2026-10-08T08:00',
  taskId: '',
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

  it('treats an empty task id as no link and keeps a valid one', () => {
    const none = validateReminderForm(valid);
    expect(none.ok && none.value.taskId).toBeNull();
    const linked = validateReminderForm({ ...valid, taskId: ' 12345 ' });
    expect(linked.ok && linked.value.taskId).toBe('12345');
  });

  it('rejects a task id longer than 64 characters', () => {
    const r = validateReminderForm({ ...valid, taskId: 'x'.repeat(65) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.taskId).toBeDefined();
    expect(validateReminderForm({ ...valid, taskId: 'x'.repeat(64) }).ok).toBe(true);
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
