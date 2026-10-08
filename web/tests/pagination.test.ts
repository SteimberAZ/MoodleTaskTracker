import { describe, expect, it } from 'vitest';
import {
  PAGE_SIZE,
  clampPage,
  homeHref,
  pageCount,
  pageRange,
  parseContentRange,
  parsePage,
  remindersHref,
  taskDetailHref,
} from '@/lib/pagination';

describe('parsePage', () => {
  it('accepts positive integers', () => {
    expect(parsePage('1')).toBe(1);
    expect(parsePage('7')).toBe(7);
    expect(parsePage(['3', '9'])).toBe(3);
  });

  it('falls back to page 1 for anything else', () => {
    for (const bad of [undefined, null, '', '0', '-2', '1.5', 'abc', '1e3', '99999999', ' 2', '2 ']) {
      expect(parsePage(bad)).toBe(1);
    }
  });
});

describe('pageCount and clampPage', () => {
  it('counts pages of 8 and never goes below 1', () => {
    expect(PAGE_SIZE).toBe(8);
    expect(pageCount(0)).toBe(1);
    expect(pageCount(1)).toBe(1);
    expect(pageCount(8)).toBe(1);
    expect(pageCount(9)).toBe(2);
    expect(pageCount(24)).toBe(3);
    expect(pageCount(25)).toBe(4);
    expect(pageCount(Number.NaN)).toBe(1);
  });

  it('clamps out-of-range and invalid pages', () => {
    expect(clampPage(1, 0)).toBe(1);
    expect(clampPage(5, 0)).toBe(1);
    expect(clampPage(5, 17)).toBe(3);
    expect(clampPage(2, 17)).toBe(2);
    expect(clampPage(0, 17)).toBe(1);
    expect(clampPage(-3, 17)).toBe(1);
    expect(clampPage(1.5, 17)).toBe(1);
  });
});

describe('pageRange', () => {
  it('maps a page to PostgREST limit and offset', () => {
    expect(pageRange(1)).toEqual({ limit: 8, offset: 0 });
    expect(pageRange(3)).toEqual({ limit: 8, offset: 16 });
    expect(pageRange(0)).toEqual({ limit: 8, offset: 0 });
    expect(pageRange(2, 5)).toEqual({ limit: 5, offset: 5 });
  });
});

describe('parseContentRange', () => {
  it('reads the total from Content-Range', () => {
    expect(parseContentRange('0-7/23')).toBe(23);
    expect(parseContentRange('*/0')).toBe(0);
    expect(parseContentRange('8-15/*')).toBeNull();
    expect(parseContentRange(null)).toBeNull();
    expect(parseContentRange('')).toBeNull();
  });
});

describe('task list links keep the filter and page', () => {
  it('omits defaults', () => {
    expect(homeHref({})).toBe('/');
    expect(homeHref({ tf: 'pendientes', tp: 1 })).toBe('/');
  });

  it('keeps the filter and the page, with an anchor', () => {
    expect(homeHref({ tf: 'silenciadas', tp: 2 }, 'tareas')).toBe('/?tf=silenciadas&tp=2#tareas');
    expect(homeHref({ tp: 2 }, 'tareas')).toBe('/?tp=2#tareas');
  });

  it('builds the detail link with the list state', () => {
    expect(taskDetailHref('abc123', {})).toBe('/tareas/abc123');
    expect(taskDetailHref('abc123', { tf: 'entregadas', tp: 4 })).toBe('/tareas/abc123?tf=entregadas&tp=4');
  });
});

describe('remindersHref', () => {
  it('points at the reminders section and omits page 1', () => {
    expect(remindersHref()).toBe('/recordatorios');
    expect(remindersHref(1)).toBe('/recordatorios');
    expect(remindersHref(3)).toBe('/recordatorios?rp=3');
  });
});
