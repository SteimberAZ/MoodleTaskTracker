import { MAX_SCHEDULE_ENTRIES } from './class-schedule';
import { normalizeText, validateEntryFields, type EntryErrors } from './schedule-entries';
import type { ScheduleClass } from './sga-schedule';

/** Pure state of the schedule editor (no React): entry model, reducer, validation and conversions. */

/** One entry as the form holds it: text inputs are strings ("" = not set). */
export interface EditorEntry {
  /** Stable React key; never sent to the server. */
  key: string;
  weekday: number;
  startTime: string;
  endTime: string;
  subject: string;
  parallel: string;
  teacher: string;
  place: string;
  roomType: string;
  roomCode: string;
  floor: string;
  /** Not editable; carried through so saving an edit does not lose what the PDF provided. */
  level: number | null;
  credits: number | null;
  department: string | null;
}

export const EDITABLE_FIELDS = [
  'subject',
  'parallel',
  'teacher',
  'weekday',
  'startTime',
  'endTime',
  'place',
  'roomType',
  'roomCode',
  'floor',
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export type EditorAction =
  | { type: 'add'; key: string }
  | { type: 'remove'; key: string }
  | { type: 'update'; key: string; patch: Partial<Pick<EditorEntry, EditableField>> }
  | { type: 'reset'; entries: EditorEntry[] };

export function blankEntry(key: string): EditorEntry {
  return {
    key,
    weekday: 1,
    startTime: '',
    endTime: '',
    subject: '',
    parallel: '',
    teacher: '',
    place: '',
    roomType: '',
    roomCode: '',
    floor: '',
    level: null,
    credits: null,
    department: null,
  };
}

export function classToEntry(cls: ScheduleClass, key: string): EditorEntry {
  return {
    key,
    weekday: cls.weekday,
    startTime: cls.startTime,
    endTime: cls.endTime,
    subject: cls.subject,
    parallel: cls.parallel ?? '',
    teacher: cls.teacher ?? '',
    place: cls.place ?? '',
    roomType: cls.roomType ?? '',
    roomCode: cls.roomCode ?? '',
    floor: cls.floor ?? '',
    level: cls.level,
    credits: cls.credits,
    department: cls.department,
  };
}

export const classesToEntries = (classes: ScheduleClass[], prefix = 'k'): EditorEntry[] =>
  classes.map((cls, i) => classToEntry(cls, `${prefix}${i}`));

const orNull = (value: string): string | null => normalizeText(value) || null;

/** Form entry -> the object sent to the server ("" -> null, whitespace collapsed). */
export function entryToClass(entry: EditorEntry): ScheduleClass {
  return {
    subject: normalizeText(entry.subject),
    level: entry.level,
    parallel: orNull(entry.parallel),
    credits: entry.credits,
    teacher: orNull(entry.teacher),
    department: entry.department,
    weekday: entry.weekday,
    startTime: entry.startTime,
    endTime: entry.endTime,
    place: orNull(entry.place),
    roomCode: orNull(entry.roomCode),
    roomType: orNull(entry.roomType),
    floor: orNull(entry.floor),
  };
}

export const entriesToClasses = (entries: EditorEntry[]): ScheduleClass[] => entries.map(entryToClass);

export function editorReducer(state: EditorEntry[], action: EditorAction): EditorEntry[] {
  switch (action.type) {
    case 'add':
      if (state.length >= MAX_SCHEDULE_ENTRIES || state.some((e) => e.key === action.key)) return state;
      return [...state, blankEntry(action.key)];
    case 'remove':
      return state.some((e) => e.key === action.key) ? state.filter((e) => e.key !== action.key) : state;
    case 'update': {
      let changed = false;
      const next = state.map((entry) => {
        if (entry.key !== action.key) return entry;
        const patch: Partial<Pick<EditorEntry, EditableField>> = {};
        for (const field of EDITABLE_FIELDS) {
          if (field in action.patch) (patch as Record<string, unknown>)[field] = action.patch[field];
        }
        changed = true;
        return { ...entry, ...patch };
      });
      return changed ? next : state;
    }
    case 'reset':
      return action.entries;
    default:
      return state;
  }
}

export interface EditorValidation {
  byKey: Record<string, EntryErrors>;
  /** Problem with the list as a whole (empty or too long). */
  listError: string | null;
  valid: boolean;
}

/** Same rules as the server (`parseScheduleEntries`), so what passes here is accepted on save. */
export function validateEditor(entries: EditorEntry[]): EditorValidation {
  const byKey: Record<string, EntryErrors> = {};
  let invalid = false;
  for (const entry of entries) {
    const errors = validateEntryFields(entryToClass(entry) as unknown as Record<string, unknown>);
    if (Object.keys(errors).length) {
      byKey[entry.key] = errors;
      invalid = true;
    }
  }
  const listError =
    entries.length === 0
      ? 'Agrega al menos una clase.'
      : entries.length > MAX_SCHEDULE_ENTRIES
        ? `El horario admite hasta ${MAX_SCHEDULE_ENTRIES} clases.`
        : null;
  return { byKey, listError, valid: !invalid && !listError };
}

/** True when the editor differs from the entries it started with (keys ignored). */
export const isDirty = (current: EditorEntry[], initial: EditorEntry[]): boolean =>
  JSON.stringify(entriesToClasses(current)) !== JSON.stringify(entriesToClasses(initial));

export const MAX_PDF_BYTES = 2 * 1024 * 1024;

/** Client-side pre-check of the chosen file; the server checks again. Returns a Spanish message or null. */
export function pdfFileProblem(file: { name: string; size: number; type: string }): string | null {
  if (file.size === 0) return 'El archivo está vacío.';
  if (file.size > MAX_PDF_BYTES) return 'El archivo supera los 2 MB.';
  const looksPdf = file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name));
  return looksPdf ? null : 'Elige un archivo PDF.';
}
