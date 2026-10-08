import { describe, expect, it } from 'vitest';
import { MAX_NEXT_LENGTH, safeNext } from '@/lib/safe-next';

describe('safeNext', () => {
  it.each([
    '//evil.com',
    '//evil.com/path',
    '/\\evil.com',
    '/\\/evil.com',
    '\\\\evil.com',
    '/foo\\bar',
    'https://evil.com',
    'http://evil.com/',
    'javascript:alert(1)',
    '/%0d%0aSet-Cookie:x=1',
    '/%0d',
    '/%2F%2Fevil.com',
    '/%5Cevil.com',
    '/\r\nLocation: https://evil.com',
    '/tab\there',
    '/%E0%A4%A',
    'evil.com',
    '',
    ' /tareas',
  ])('rejects %j', (raw) => {
    expect(safeNext(raw)).toBe('/');
  });

  it('rejects non-strings and oversized values', () => {
    expect(safeNext(null)).toBe('/');
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext(42)).toBe('/');
    expect(safeNext(['/tareas'])).toBe('/');
    expect(safeNext('/' + 'a'.repeat(MAX_NEXT_LENGTH))).toBe('/');
  });

  it('never returns the login page (it would loop)', () => {
    expect(safeNext('/login')).toBe('/');
    expect(safeNext('/login?next=/x')).toBe('/');
  });

  it.each(['/', '/tareas', '/tareas?tab=atrasadas&page=2', '/tareas/123#detalle', '/horario?u=a%20b', '/cuenta/'])(
    'keeps the same-origin path %j',
    (raw) => {
      expect(safeNext(raw)).toBe(raw);
    },
  );
});
