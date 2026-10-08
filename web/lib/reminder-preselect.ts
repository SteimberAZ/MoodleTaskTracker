import { isSafeId } from './queries';

/** Normalizes `?task=` from the query string: first value, trimmed, and only if it looks like a task id. */
export function parsePreselectParam(raw: string | string[] | undefined | null): string | null {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && isSafeId(value) ? value : null;
}

/**
 * The task to preselect in the new-reminder form, or null. The id only counts when the
 * (owner-scoped) lookup finds it, so a foreign or unknown id never reaches the form.
 */
export async function resolvePreselect<T extends { id: string }>(
  raw: string | string[] | undefined | null,
  lookup: (id: string) => Promise<T | null>,
): Promise<T | null> {
  const id = parsePreselectParam(raw);
  if (!id) return null;
  try {
    const task = await lookup(id);
    return task && task.id === id ? task : null;
  } catch {
    return null;
  }
}
