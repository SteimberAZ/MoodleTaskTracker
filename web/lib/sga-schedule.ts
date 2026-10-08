/**
 * Pure parser for the SGA "Horario de clases" PDF. It receives the text items of every page WITH their
 * coordinates (see `pdf-text.ts`) and returns the classes, one per schedule entry. It never throws and never
 * reads personal header data (student name, cedula): only the `Periodo:` value is taken from the header block.
 *
 * Layout of the printed table (verified on a real PDF, landscape page, PDF y axis pointing up):
 *   ASIGNATURA | NIVEL | PARAL. | CREDI. | DOCENTE | DEPARTAMENTO DOCENTE | HORARIO Y AMBIENTE
 * Every cell is vertically centred inside its row, so a row is NOT "everything below its first line": the
 * subject line sits in the middle of a tall schedule cell. Rows are therefore found from the vertical gaps
 * between text lines (cells of one row are dense, rows are separated by padding), and columns from the
 * horizontal gaps between text blocks (headers are centred over the columns, the body text is left aligned).
 */

export interface PdfTextItem {
  str: string;
  /** Left edge. */
  x: number;
  /** Baseline; larger is higher on the page. */
  y: number;
  width: number;
}

export interface PdfPageText {
  items: PdfTextItem[];
}

/** One schedule entry of one subject; becomes one `moodle_class_schedule` row. */
export interface ScheduleClass {
  subject: string;
  level: number | null;
  parallel: string | null;
  credits: number | null;
  teacher: string | null;
  department: string | null;
  /** ISO weekday: 1 = lunes ... 7 = domingo. */
  weekday: number;
  /** "HH:MM". */
  startTime: string;
  endTime: string;
  place: string | null;
  roomCode: string | null;
  roomType: string | null;
  floor: string | null;
}

export interface ParsedSchedule {
  periodLabel: string | null;
  /** "YYYY-MM-DD": last day of the period's final month. */
  periodEnd: string | null;
  classes: ScheduleClass[];
  /** Spanish, user-facing notes about rows that could not be fully read. */
  warnings: string[];
}

type ColumnKey = 'subject' | 'level' | 'parallel' | 'credits' | 'teacher' | 'department' | 'schedule';
type Placed = PdfTextItem & { col: ColumnKey; page: number };

/** Two lines closer than this (PDF units) belong to the same cell; further apart starts a new row. */
const ROW_GAP = 20;
/** Max baseline distance between wrapped lines of one subject. */
const SUBJECT_LINE_GAP = 16;
/** Items whose baselines differ by less than this are on the same text line. */
const SAME_LINE = 2.5;
/** Text blocks closer than this horizontally are the same column. */
const COLUMN_GAP = 3;

const MONTHS: Record<string, number> = {
  ENERO: 1,
  FEBRERO: 2,
  MARZO: 3,
  ABRIL: 4,
  MAYO: 5,
  JUNIO: 6,
  JULIO: 7,
  AGOSTO: 8,
  SEPTIEMBRE: 9,
  SETIEMBRE: 9,
  OCTUBRE: 10,
  NOVIEMBRE: 11,
  DICIEMBRE: 12,
};

const WEEKDAYS: Record<string, number> = {
  LUNES: 1,
  MARTES: 2,
  MIERCOLES: 3,
  JUEVES: 4,
  VIERNES: 5,
  SABADO: 6,
  DOMINGO: 7,
};

const DAY_ENTRY =
  /(LUNES|MARTES|MI[EÉ]RCOLES|JUEVES|VIERNES|S[AÁ]BADO|DOMINGO)\s*\((\d{2}:\d{2})(?::\d{2})?-(\d{2}:\d{2})(?::\d{2})?\)/gi;

/** Upper-case, accent-free, letters and spaces only: the form used to recognise header words. */
function norm(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

function sanitizeItem(raw: PdfTextItem | null | undefined): PdfTextItem | null {
  if (!raw || typeof raw.str !== 'string') return null;
  const str = raw.str.normalize('NFC');
  if (!str.trim()) return null;
  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null;
  return { str, x: raw.x, y: raw.y, width: Number.isFinite(raw.width) ? raw.width : 0 };
}

/** Joins items into text: lines top to bottom, items left to right, adjacent fragments without a space. */
function cellText(items: Placed[]): string {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y);
  const lines: Placed[][] = [];
  for (const item of sorted) {
    const line = lines[lines.length - 1];
    if (line && line[0].page === item.page && Math.abs(line[0].y - item.y) <= SAME_LINE) line.push(item);
    else lines.push([item]);
  }
  return squash(
    lines
      .map((line) => {
        line.sort((a, b) => a.x - b.x);
        let out = '';
        line.forEach((item, i) => {
          const text = item.str.trim();
          if (i > 0) {
            const prev = line[i - 1];
            out += item.x - (prev.x + prev.width) < 0.8 ? '' : ' ';
          }
          out += text;
        });
        return out;
      })
      .join(' '),
  );
}

// ---------------------------------------------------------------------------------------------- period

/** `SEPTIEMBRE 2026 - ENERO 2027 (PREGRADO)` -> `2027-01-31` (last day of the last month named); null if unreadable. */
export function parsePeriodEnd(label: string | null | undefined): string | null {
  if (!label) return null;
  const re = /(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|SETIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s+(\d{4})/g;
  const text = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) return null;
  const month = MONTHS[last[1]];
  const year = Number(last[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

function findPeriodLabel(pages: PdfTextItem[][]): string | null {
  for (const items of pages) {
    for (const item of items) {
      const m = /^per[ií]odo\s*:\s*(.*)$/i.exec(item.str.trim());
      if (!m) continue;
      if (m[1].trim()) return squash(m[1]);
      // The value is the run of items right after the label; other header fields on the same line are further away.
      const rest = items
        .filter((o) => o !== item && Math.abs(o.y - item.y) <= SAME_LINE && o.x >= item.x + item.width - 1)
        .sort((a, b) => a.x - b.x);
      const run: Placed[] = [];
      let edge = item.x + item.width;
      for (const o of rest) {
        // The label and its value are far apart (the value is left aligned in its own column).
        if (o.x - edge > (run.length === 0 ? 80 : 30)) break;
        run.push({ ...o, col: 'subject', page: 0 });
        edge = Math.max(edge, o.x + o.width);
      }
      const value = cellText(run);
      if (value) return value;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- table

interface Header {
  col: ColumnKey;
  center: number;
}

interface Table {
  body: PdfTextItem[];
  headers: Header[];
}

const center = (item: PdfTextItem): number => item.x + item.width / 2;

/** Finds the header row, the body items under it and the column centres. Null when the page has no table. */
function locateTable(items: PdfTextItem[]): Table | null {
  const subjectHeader = items.find((i) => norm(i.str) === 'ASIGNATURA');
  const scheduleHeader = items.find((i) => /^HORARIO Y AMBIENTE/.test(norm(i.str)));
  if (!subjectHeader || !scheduleHeader) return null;

  const near = (i: PdfTextItem) => Math.abs(i.y - subjectHeader.y) <= 16;
  const level = items.find((i) => near(i) && norm(i.str) === 'NIVEL');
  const parallel = items.find((i) => near(i) && /^PARAL/.test(norm(i.str)));
  const credits = items.find((i) => near(i) && /^CREDI/.test(norm(i.str)));
  const dept = items.find((i) => near(i) && /^DEPARTAMENTO/.test(norm(i.str)));
  const teacherCandidates = items.filter((i) => near(i) && /^DOCENTE$/.test(norm(i.str)));
  // "DEPARTAMENTO / DOCENTE" is a two-line header: its second line must not be taken as the teacher header.
  const teacher = teacherCandidates
    .filter((i) => !dept || Math.abs(center(i) - center(dept)) > 15)
    .sort((a, b) => Math.abs(a.y - subjectHeader.y) - Math.abs(b.y - subjectHeader.y))[0];

  const found: [ColumnKey, PdfTextItem | undefined][] = [
    ['subject', subjectHeader],
    ['level', level],
    ['parallel', parallel],
    ['credits', credits],
    ['teacher', teacher],
    ['department', dept],
    ['schedule', scheduleHeader],
  ];
  const headers: Header[] = found.filter((f): f is [ColumnKey, PdfTextItem] => !!f[1]).map(([col, item]) => ({ col, center: center(item) }));

  const headerItems = [subjectHeader, scheduleHeader, level, parallel, credits, dept, ...teacherCandidates].filter(
    (i): i is PdfTextItem => !!i,
  );
  const headerBottom = Math.min(...headerItems.map((i) => i.y));

  const legend = items.find((i) => norm(i.str) === 'LEYENDA' && i.y < headerBottom);
  const legendCut = legend ? legend.y + 6 : -Infinity;

  const body = items.filter(
    (i) =>
      i.y < headerBottom - 4 &&
      i.y > legendCut &&
      !/Sistema de Gesti[oó]n Acad/i.test(i.str) &&
      !/^\s*\d+\s+de\s+\d+\s*$/i.test(i.str),
  );
  return { body, headers };
}

/** Merges the horizontal extents of the body items into blocks separated by visible gaps. */
function columnBlocks(items: PdfTextItem[]): { start: number; end: number }[] {
  const spans = items.map((i) => ({ start: i.x, end: i.x + i.width })).sort((a, b) => a.start - b.start);
  const blocks: { start: number; end: number }[] = [];
  for (const span of spans) {
    const last = blocks[blocks.length - 1];
    if (last && span.start <= last.end + COLUMN_GAP) last.end = Math.max(last.end, span.end);
    else blocks.push({ ...span });
  }
  return blocks;
}

function nearestHeader(headers: Header[], x: number): ColumnKey {
  return headers.reduce((best, h) => (Math.abs(h.center - x) < Math.abs(best.center - x) ? h : best), headers[0]).col;
}

/**
 * Tags every body item with its column. Headers are centred over their column while the body text is left
 * aligned, so the column is the text block (see `columnBlocks`) that contains the header centre; a block with
 * no header centre (e.g. only "—" departments) goes to the nearest header, and a block holding several
 * header centres is split by each item's own centre.
 */
function placeItems(table: Table, page: number): Placed[] {
  const blocks = columnBlocks(table.body);
  return table.body.map((item) => {
    const block = blocks.find((b) => item.x >= b.start && item.x <= b.end) ?? { start: item.x, end: item.x + item.width };
    const inside = table.headers.filter((h) => h.center >= block.start - 1 && h.center <= block.end + 1);
    let col: ColumnKey;
    if (inside.length === 1) col = inside[0].col;
    else if (inside.length > 1) col = nearestHeader(inside, center(item));
    else col = nearestHeader(table.headers, (block.start + block.end) / 2);
    return { ...item, col, page };
  });
}

/** Groups items into rows by vertical gaps (top to bottom). */
function groupRows(items: Placed[]): Placed[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const groups: Placed[][] = [];
  for (const item of sorted) {
    const group = groups[groups.length - 1];
    if (group && group[group.length - 1].y - item.y <= ROW_GAP) group.push(item);
    else groups.push([item]);
  }
  return groups;
}

/** Safety net: a group holding two subjects (rows padded too tightly) is split around each subject block. */
function splitByCourse(group: Placed[]): Placed[][] {
  const ys = group
    .filter((i) => i.col === 'subject')
    .map((i) => i.y)
    .sort((a, b) => b - a);
  const clusters: number[][] = [];
  for (const y of ys) {
    const last = clusters[clusters.length - 1];
    if (last && last[last.length - 1] - y <= SUBJECT_LINE_GAP) last.push(y);
    else clusters.push([y]);
  }
  if (clusters.length <= 1) return [group];
  const centers = clusters.map((c) => (c[0] + c[c.length - 1]) / 2);
  const buckets: Placed[][] = centers.map(() => []);
  for (const item of group) {
    let best = 0;
    centers.forEach((c, i) => {
      if (Math.abs(item.y - c) < Math.abs(item.y - centers[best])) best = i;
    });
    buckets[best].push(item);
  }
  return buckets;
}

// ---------------------------------------------------------------------------------------------- cells

const DASHES = new Set(['', '—', '-', '–', '−']);

const orNull = (text: string): string | null => (DASHES.has(text.trim()) ? null : text.trim());

function toInt(text: string): number | null {
  const m = /\d+/.exec(text);
  return m ? Number.parseInt(m[0], 10) : null;
}

export interface ScheduleEntry {
  weekday: number;
  startTime: string;
  endTime: string;
  place: string | null;
  roomCode: string | null;
  roomType: string | null;
  floor: string | null;
}

/** "FACULTAD DE CIENCIAS INFORMÁTICAS ()" -> without the empty parentheses; "X (X)" -> "X". */
function cleanPlace(text: string): string | null {
  let place = squash(text.replace(/\(\s*\)/g, ''));
  const m = /^(.*?)\s*\(([^()]+)\)$/.exec(place);
  if (m && m[1].toUpperCase().includes(m[2].trim().toUpperCase())) place = m[1];
  return orNull(place);
}

const field = (segment: string, re: RegExp): string | null => {
  const m = re.exec(segment);
  return m ? orNull(squash(m[1])) : null;
};

/** The HORARIO Y AMBIENTE text of one course -> one entry per `DAY (HH:MM-HH:MM)` block. */
export function parseScheduleCell(text: string): ScheduleEntry[] {
  const matches = [...text.matchAll(DAY_ENTRY)];
  const entries: ScheduleEntry[] = [];
  matches.forEach((m, i) => {
    const weekday = WEEKDAYS[norm(m[1])];
    const start = m[2];
    const end = m[3];
    if (!weekday || !validTime(start) || !validTime(end) || start >= end) return;
    const segment = text.slice((m.index ?? 0) + m[0].length, matches[i + 1]?.index ?? text.length);
    const lugar = /LUGAR\s*:\s*(.*?)(?=COD\.?\s*AMB|TIPO\s*:|PISO\s*:|$)/i.exec(segment);
    entries.push({
      weekday,
      startTime: start,
      endTime: end,
      place: lugar ? cleanPlace(lugar[1]) : null,
      roomCode: field(segment, /COD\.?\s*AMB\.?\s*:\s*(.*?)\s*(?:;|TIPO\s*:|PISO\s*:|$)/i),
      roomType: field(segment, /TIPO\s*:\s*(.*?)\s*(?:;|PISO\s*:|$)/i),
      floor: field(segment, /PISO\s*:\s*(.*?)\s*(?:;|$)/i),
    });
  });
  return entries;
}

function validTime(value: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

// ---------------------------------------------------------------------------------------------- entry point

/** Parses the text items of every page of an SGA schedule PDF. Never throws. */
export function parseSgaSchedule(pages: PdfPageText[]): ParsedSchedule {
  const warnings: string[] = [];
  try {
    const clean = (pages ?? []).map((p) => (p?.items ?? []).map(sanitizeItem).filter((i): i is PdfTextItem => !!i));
    const periodLabel = findPeriodLabel(clean);

    const rows: Placed[][] = [];
    let tablePages = 0;
    clean.forEach((items, pageIndex) => {
      const table = locateTable(items);
      if (!table) return;
      tablePages++;
      for (const group of groupRows(placeItems(table, pageIndex))) {
        for (const row of splitByCourse(group)) {
          if (row.some((i) => i.col === 'subject')) rows.push(row);
          // Lines with no subject continue the previous row (e.g. a cell split by a page break).
          else if (rows.length) rows[rows.length - 1].push(...row);
        }
      }
    });
    if (tablePages === 0) warnings.push('No se encontró la tabla de horarios en el PDF.');

    const classes: ScheduleClass[] = [];
    for (const row of rows) {
      const text = (col: ColumnKey) => cellText(row.filter((i) => i.col === col));
      const subject = text('subject');
      if (!subject) continue;
      const entries = parseScheduleCell(text('schedule'));
      if (entries.length === 0) {
        warnings.push(`${subject}: no tiene un horario asignado en el PDF.`);
        continue;
      }
      const parallel = orNull(text('parallel').replace(/["'“”«»]/g, ''));
      for (const entry of entries) {
        classes.push({
          subject,
          level: toInt(text('level')),
          parallel,
          credits: toInt(text('credits')),
          teacher: orNull(text('teacher')),
          department: orNull(text('department')),
          ...entry,
        });
      }
    }
    if (tablePages > 0 && classes.length === 0) warnings.push('No se encontraron clases con horario en el PDF.');
    return { periodLabel, periodEnd: parsePeriodEnd(periodLabel), classes, warnings };
  } catch {
    return {
      periodLabel: null,
      periodEnd: null,
      classes: [],
      warnings: [...warnings, 'No se pudo interpretar el contenido del PDF.'],
    };
  }
}
