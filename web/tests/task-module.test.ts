import { describe, expect, it } from 'vitest';
import { moduleLabel } from '@/lib/task-module';
import { normalizeDescription, normalizeTeachers, safeHttpUrl } from '@/lib/task-detail';

describe('moduleLabel', () => {
  it('maps the common Moodle modules', () => {
    expect(moduleLabel('assign')).toBe('Tarea');
    expect(moduleLabel('quiz')).toBe('Cuestionario');
    expect(moduleLabel('forum')).toBe('Foro');
    expect(moduleLabel('workshop')).toBe('Taller');
    expect(moduleLabel('lesson')).toBe('Lección');
  });

  it('is case-insensitive and tolerant of old rows', () => {
    expect(moduleLabel(' Quiz ')).toBe('Cuestionario');
    expect(moduleLabel(null)).toBe('Actividad');
    expect(moduleLabel(undefined)).toBe('Actividad');
    expect(moduleLabel('')).toBe('Actividad');
    expect(moduleLabel('something_new')).toBe('Actividad');
  });
});

describe('task detail helpers', () => {
  it('normalizes the teachers jsonb', () => {
    expect(normalizeTeachers(['Ana Pérez', ' Luis Mora ', 'Ana Pérez', '', 3, null])).toEqual(['Ana Pérez', 'Luis Mora']);
    expect(normalizeTeachers(null)).toEqual([]);
    expect(normalizeTeachers(undefined)).toEqual([]);
    expect(normalizeTeachers('Ana')).toEqual([]);
    expect(normalizeTeachers({ a: 1 })).toEqual([]);
  });

  it('only allows http(s) Moodle links', () => {
    expect(safeHttpUrl('https://evirtual.utm.edu.ec/mod/assign/view.php?id=1')).toBe(
      'https://evirtual.utm.edu.ec/mod/assign/view.php?id=1',
    );
    expect(safeHttpUrl('http://x.test')).toBe('http://x.test');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,hi')).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });

  it('keeps description line breaks and treats blank as missing', () => {
    expect(normalizeDescription('Línea 1\r\nLínea 2\n\nLínea 4 ')).toBe('Línea 1\nLínea 2\n\nLínea 4');
    expect(normalizeDescription('<b>no html</b>')).toBe('<b>no html</b>');
    expect(normalizeDescription('  \n ')).toBeNull();
    expect(normalizeDescription(null)).toBeNull();
  });
});
