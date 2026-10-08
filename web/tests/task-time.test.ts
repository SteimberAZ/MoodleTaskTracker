import { describe, expect, it } from 'vitest';
import { timeLeft } from '@/lib/task-time';

const NOW = 1_800_000_000;

describe('timeLeft', () => {
  it('reports days, not urgent', () => {
    expect(timeLeft(NOW + 2 * 86400 + 3600, NOW)).toEqual({ label: 'faltan 2 días', urgent: false });
    expect(timeLeft(NOW + 86400, NOW)).toEqual({ label: 'falta 1 día', urgent: false });
  });

  it('reports hours and flags urgency under 24h', () => {
    expect(timeLeft(NOW + 5 * 3600 + 10, NOW)).toEqual({ label: 'faltan 5 horas', urgent: true });
    expect(timeLeft(NOW + 86400 - 1, NOW)).toEqual({ label: 'faltan 23 horas', urgent: true });
    expect(timeLeft(NOW + 3600, NOW)).toEqual({ label: 'falta 1 hora', urgent: true });
  });

  it('reports minutes under one hour', () => {
    expect(timeLeft(NOW + 59 * 60, NOW)).toEqual({ label: 'faltan 59 minutos', urgent: true });
    expect(timeLeft(NOW + 10, NOW)).toEqual({ label: 'falta 1 minuto', urgent: true });
  });

  it('marks passed deadlines', () => {
    expect(timeLeft(NOW, NOW)).toEqual({ label: 'vencida', urgent: true });
    expect(timeLeft(NOW - 5, NOW)).toEqual({ label: 'vencida', urgent: true });
  });
});
