export interface TimeLeft {
  /** Spanish label such as "faltan 2 días". */
  label: string;
  /** True when less than 24 hours remain (or the deadline already passed). */
  urgent: boolean;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Remaining time until a Moodle deadline.
 * `dueTimestamp` and `nowSeconds` are Unix seconds (the worker stores `int(datetime.timestamp())`).
 */
export function timeLeft(dueTimestamp: number, nowSeconds: number): TimeLeft {
  const diff = dueTimestamp - nowSeconds;
  if (diff <= 0) return { label: 'vencida', urgent: true };
  if (diff < HOUR) {
    const m = Math.max(1, Math.floor(diff / MINUTE));
    return { label: `falta${m === 1 ? '' : 'n'} ${plural(m, 'minuto', 'minutos')}`, urgent: true };
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return { label: `falta${h === 1 ? '' : 'n'} ${plural(h, 'hora', 'horas')}`, urgent: true };
  }
  const d = Math.floor(diff / DAY);
  return { label: `falta${d === 1 ? '' : 'n'} ${plural(d, 'día', 'días')}`, urgent: false };
}
