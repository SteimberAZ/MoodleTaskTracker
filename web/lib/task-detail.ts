/** Pure helpers for the task detail page. */

/** Teachers come from a jsonb column: keep only non-empty strings, trimmed and de-duplicated. Null/missing = none. */
export function normalizeTeachers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names = raw
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

/** Only http(s) links are rendered as "Abrir en Moodle" (blocks `javascript:` and friends). */
export function safeHttpUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

/** Description is plain text; empty or whitespace-only counts as missing. */
export function normalizeDescription(raw: string | null | undefined): string | null {
  const text = (raw ?? '').replace(/\r\n?/g, '\n').trim();
  return text || null;
}
