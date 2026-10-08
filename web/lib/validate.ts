import { guayaquilInputToDate } from './time';
import {
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  isIntervalUnit,
  toIntervalMinutes,
} from './schedule';

export interface ReminderFormInput {
  title: string;
  message: string;
  amount: string;
  unit: string;
  startsAt: string;
  endsAt: string;
}

export type FieldErrors = Partial<Record<keyof ReminderFormInput, string>>;

export interface ReminderValues {
  title: string;
  message: string | null;
  intervalMinutes: number;
  startsAt: Date;
  endsAt: Date;
}

export type ValidationResult =
  | { ok: true; value: ReminderValues }
  | { ok: false; errors: FieldErrors };

export const MAX_TITLE = 120;
export const MAX_MESSAGE = 1000;

export function validateReminderForm(input: ReminderFormInput): ValidationResult {
  const errors: FieldErrors = {};

  const title = input.title.trim();
  if (!title) errors.title = 'El título es obligatorio.';
  else if (title.length > MAX_TITLE) errors.title = `El título no puede superar ${MAX_TITLE} caracteres.`;

  const message = input.message.trim();
  if (message.length > MAX_MESSAGE) errors.message = `El mensaje no puede superar ${MAX_MESSAGE} caracteres.`;

  let intervalMinutes = 0;
  const amountText = input.amount.trim();
  if (!/^\d{1,7}$/.test(amountText) || Number(amountText) < 1) {
    errors.amount = 'Ingresa un número entero mayor a 0.';
  } else if (!isIntervalUnit(input.unit)) {
    errors.unit = 'Elige una unidad válida.';
  } else {
    intervalMinutes = toIntervalMinutes(Number(amountText), input.unit);
    if (intervalMinutes < MIN_INTERVAL_MINUTES) {
      errors.amount = `La frecuencia mínima es de ${MIN_INTERVAL_MINUTES} minutos.`;
    } else if (intervalMinutes > MAX_INTERVAL_MINUTES) {
      errors.amount = 'La frecuencia máxima es de 1 año.';
    }
  }

  const startsAt = guayaquilInputToDate(input.startsAt);
  if (!startsAt) errors.startsAt = 'Fecha de inicio inválida.';
  const endsAt = guayaquilInputToDate(input.endsAt);
  if (!endsAt) errors.endsAt = 'Fecha de término inválida.';
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    errors.endsAt = 'La fecha de término debe ser posterior al inicio.';
  }

  if (Object.keys(errors).length > 0 || !startsAt || !endsAt) return { ok: false, errors };
  return {
    ok: true,
    value: { title, message: message || null, intervalMinutes, startsAt, endsAt },
  };
}
