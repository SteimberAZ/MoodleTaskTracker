import { REMINDERS_PATH } from './nav';

/** Pure pagination helpers shared by the task and reminder lists. */
export const PAGE_SIZE = 8;

/** Largest page number we accept from a query string (guards against absurd offsets). */
const MAX_PAGE = 10_000;

/** Reads `?tp=` / `?rp=`: anything that is not a positive integer becomes page 1. */
export function parsePage(raw: string | string[] | undefined | null): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d{1,5}$/.test(value)) return 1;
  const n = Number(value);
  return n >= 1 && n <= MAX_PAGE ? n : 1;
}

/** Number of pages for `total` rows; at least 1 so an empty list still reads "Página 1 de 1". */
export function pageCount(total: number, pageSize = PAGE_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.ceil(total / pageSize);
}

/** Clamps a requested page into `1..pageCount(total)`. */
export function clampPage(page: number, total: number, pageSize = PAGE_SIZE): number {
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, pageCount(total, pageSize));
}

/** PostgREST `limit` / `offset` for a 1-based page. */
export function pageRange(page: number, pageSize = PAGE_SIZE): { limit: number; offset: number } {
  const safe = Number.isInteger(page) && page >= 1 ? page : 1;
  return { limit: pageSize, offset: (safe - 1) * pageSize };
}

// Total row count from a PostgREST `Content-Range` header ("0-7/23", or "star/0" when empty); null when absent.
export function parseContentRange(header: string | null | undefined): number | null {
  if (!header) return null;
  const match = /\/(\d+)$/.exec(header.trim());
  return match ? Number(match[1]) : null;
}

export interface HomeParams {
  /** Task page and task filter. Defaults are omitted from the URL. */
  tp?: number;
  tf?: string;
}

/** Non-default task list state as a query string (no leading "?"). */
function listQuery(params: HomeParams): string {
  const query = new URLSearchParams();
  if (params.tf && params.tf !== 'pendientes') query.set('tf', params.tf);
  if (params.tp && params.tp > 1) query.set('tp', String(params.tp));
  return query.toString();
}

/** `/` (task list) link. `anchor` scrolls back to the section the control belongs to. */
export function homeHref(params: HomeParams, anchor?: 'tareas'): string {
  const qs = listQuery(params);
  return `/${qs ? `?${qs}` : ''}${anchor ? `#${anchor}` : ''}`;
}

/** `/recordatorios` link for a reminder page (`?rp=`); page 1 is the bare path. */
export function remindersHref(page = 1): string {
  return page > 1 ? `${REMINDERS_PATH}?rp=${page}` : REMINDERS_PATH;
}

/** `/tareas/<id>` link that carries the list state so "Volver" lands on the same page. */
export function taskDetailHref(taskId: string, params: HomeParams): string {
  const qs = listQuery(params);
  return `/tareas/${encodeURIComponent(taskId)}${qs ? `?${qs}` : ''}`;
}
