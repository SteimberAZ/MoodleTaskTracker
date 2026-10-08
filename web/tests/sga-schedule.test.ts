import { describe, expect, it } from 'vitest';
import {
  parsePeriodEnd,
  parseScheduleCell,
  parseSgaSchedule,
  type PdfPageText,
  type PdfTextItem,
} from '@/lib/sga-schedule';

// ---------------------------------------------------------------------------------------------------------------
// Synthetic fixtures. They copy the geometry of the real SGA PDF (landscape page, PDF y axis pointing up, headers
// centred over their columns, body text left aligned, every cell vertically centred in its row) with made-up data.
// ---------------------------------------------------------------------------------------------------------------

const PITCH = 12;
const CHAR = 4.2;
const t = (x: number, y: number, str: string, width = str.length * CHAR): PdfTextItem => ({ str, x, y, width });

/** Table header row; `top` is the baseline of the first header line (the real PDF has 373.4 and 566.7). */
function header(top: number): PdfTextItem[] {
  return [
    t(92.3, top, 'ASIGNATURA', 50.4),
    t(220.6, top, 'NIVEL', 22.6),
    t(256.2, top, 'PARAL.', 27.5),
    t(295, top, 'CREDI.', 25.5),
    t(363, top, 'DOCENTE', 37.2),
    t(453.3, top + 6.3, 'DEPARTAMENTO', 64.2),
    t(466.8, top - 5.7, 'DOCENTE', 37.2),
    t(609.7, top, 'HORARIO Y AMBIENTE', 84.7),
  ];
}

/** Everything that sits above the table in the real PDF: titles, student data, QR text. Personal data is fake. */
function pageHeaderBlock(period = 'SEPTIEMBRE 2026 - ENERO 2027 (PREGRADO)'): PdfTextItem[] {
  return [
    t(139.9, 489.1, 'Período:', 39.8),
    t(224.6, 489.1, period),
    t(139.9, 472.9, 'Estudiante:', 53.6),
    t(224.6, 472.9, 'ESTUDIANTE FICTICIO UNO'),
    t(529.9, 419.2, 'Cédula:', 35.8),
    t(642.8, 419.2, '0000000000', 54.9),
    t(656.5, 544.8, 'HORARIO DE', 113.9),
    t(693.7, 524.4, 'CLASES', 77),
  ];
}

const footer = (n: number, of: number): PdfTextItem[] => [t(658.3, 61.5, `Sistema de Gestión Académica - UTM ${n} de ${of}`, 99.2)];

const legend = (top: number): PdfTextItem[] => [
  t(207.5, top, 'LEYENDA', 40.4),
  t(422.2, top, 'DESCRIPCIÓN', 59.8),
  t(203.2, top - 18, 'APROBADO', 49),
  t(288.4, top - 18, 'PARALELO QUE CUMPLE CON EL MÍNIMO DE ESTUDIANTES INSCRITOS.', 293.6),
  t(202.9, top - 43, 'PENDIENTE', 49.6),
  t(288.4, top - 43, 'PARALELO QUE ACTUALMENTE NO CUMPLE CON EL MÍNIMO DE ESTUDIANTES', 323.1),
];

interface Entry {
  day: string;
  time: string;
  /** Place text lines (the first one shares the line with "LUGAR:"). */
  place?: string[];
  code?: string;
  /** TIPO value lines (may wrap), PISO value. */
  type?: string[];
  floor?: string;
}

interface Course {
  subject: string[];
  level?: string;
  parallel?: string;
  credits?: string;
  teacher?: string[];
  /** Lines of the department cell; undefined leaves the column empty (no items at all). */
  dept?: string[];
  entries: Entry[];
}

const PLACE = ['FACULTAD DE CIENCIAS', 'INFORMÁTICAS (CIENCIAS INFORMÁTICAS)'];

/** Lines of one schedule cell as [x, text][] groups (items on the same line share a baseline). */
function scheduleLines(entries: Entry[]): [number, string][][] {
  const lines: [number, string][][] = [];
  for (const e of entries) {
    lines.push([[566.6, `${e.day} (${e.time})`]]);
    const place = e.place ?? PLACE;
    lines.push([[594.8, 'LUGAR:'], [625.2, place[0]]]);
    for (const extra of place.slice(1)) lines.push([[594.8, extra]]);
    const type = e.type ?? ['AULA;'];
    lines.push([[594.8, 'COD. AMB.:'], [638.2, `${e.code ?? '1-59-1-01-A'};`], [686.7, 'TIPO:'], [708.6, type[0]]]);
    if (type.length > 1) {
      lines.push([[594.8, type[1]], [667, 'PISO:'], [689.1, `${e.floor ?? '1'};`]]);
    } else {
      lines.push([[594.8, 'PISO:'], [617, `${e.floor ?? '1'};`]]);
    }
  }
  return lines;
}

/** Places a course with its first (tallest cell) baseline at `top`. Returns the items and the next free baseline. */
function placeCourse(course: Course, top: number, rowPadding = 32): { items: PdfTextItem[]; next: number; centerY: number } {
  const sched = scheduleLines(course.entries);
  const cells: Record<string, string[]> = {
    subject: course.subject,
    teacher: course.teacher ?? ['DOCENTE UNO', 'FICTICIO'],
    ...(course.dept ? { dept: course.dept } : {}),
  };
  const height = Math.max(sched.length, ...Object.values(cells).map((l) => l.length));
  const centerY = top - ((height - 1) * PITCH) / 2;
  const items: PdfTextItem[] = [];
  sched.forEach((line, i) => line.forEach(([x, text]) => items.push(t(x, top - i * PITCH, text))));
  const centered = (lines: string[], x: number) =>
    lines.forEach((text, i) => items.push(t(x, centerY + ((lines.length - 1) * PITCH) / 2 - i * PITCH, text)));
  centered(cells.subject, 26.3);
  centered(cells.teacher, 330.8);
  if (cells.dept) centered(cells.dept, 441.6);
  items.push(t(229.8, centerY, course.level ?? '5', 4.2));
  items.push(t(263.8, centerY, `"${course.parallel ?? 'A'}"`, 12.4));
  items.push(t(305.7, centerY, course.credits ?? '3', 4.2));
  return { items, next: top - (height - 1) * PITCH - rowPadding, centerY };
}

function page(opts: { headerTop: number; courses: Course[]; first?: boolean; legend?: boolean; n: number; of: number; period?: string }): PdfPageText {
  const items: PdfTextItem[] = [...header(opts.headerTop), ...footer(opts.n, opts.of)];
  if (opts.first) items.push(...pageHeaderBlock(opts.period));
  let top = opts.headerTop - 31;
  for (const course of opts.courses) {
    const placed = placeCourse(course, top);
    items.push(...placed.items);
    top = placed.next;
  }
  if (opts.legend) items.push(...legend(top - 20));
  return { items };
}

const DEPT = ['TECNOLOGÍAS DE LA', 'INFORMACIÓN Y', 'COMUNICACIÓN'];

const LAB: Entry = {
  day: 'MARTES',
  time: '07:00:00-09:00:00',
  code: '1-59-1-03-LC',
  type: ['LABORATORIO', 'DE COMPUTACION;'],
  floor: '1',
};

const TWO_PAGES: PdfPageText[] = [
  page({
    n: 1,
    of: 2,
    first: true,
    headerTop: 373.4,
    courses: [
      {
        subject: ['MATERIA FICTICIA UNO'],
        parallel: 'A',
        credits: '4',
        dept: DEPT,
        entries: [LAB, { day: 'MIERCOLES', time: '07:00:00-09:00:00', code: '1-59-3-08-L', type: ['LABORATORIO;'], floor: '3', place: ['FACULTAD DE CIENCIAS', 'INFORMÁTICAS ()'] }],
      },
      {
        subject: ['MATERIA FICTICIA DOS'],
        parallel: 'B',
        credits: '2',
        dept: ['—'],
        entries: [{ day: 'JUEVES', time: '16:00:00-18:00:00', code: '1-59-2-02-A', floor: '2' }],
      },
    ],
  }),
  page({
    n: 2,
    of: 2,
    headerTop: 566.7,
    legend: true,
    courses: [
      {
        subject: ['MATERIA FICTICIA TRES CON UN NOMBRE LARGO', '(ABC)'],
        parallel: 'B',
        credits: '2',
        dept: ['—'],
        entries: [{ day: 'LUNES', time: '07:00:00-09:00:00', code: '1-59-3-01-A', floor: '3' }],
      },
    ],
  }),
];

describe('parseSgaSchedule on a multi-page table', () => {
  const result = parseSgaSchedule(TWO_PAGES);

  it('returns one class per schedule entry', () => {
    expect(result.warnings).toEqual([]);
    expect(result.classes.map((c) => [c.subject, c.weekday, c.startTime, c.endTime])).toEqual([
      ['MATERIA FICTICIA UNO', 2, '07:00', '09:00'],
      ['MATERIA FICTICIA UNO', 3, '07:00', '09:00'],
      ['MATERIA FICTICIA DOS', 4, '16:00', '18:00'],
      ['MATERIA FICTICIA TRES CON UN NOMBRE LARGO (ABC)', 1, '07:00', '09:00'],
    ]);
  });

  it('reads the period only from the header block', () => {
    expect(result.periodLabel).toBe('SEPTIEMBRE 2026 - ENERO 2027 (PREGRADO)');
    expect(result.periodEnd).toBe('2027-01-31');
  });

  it('strips the quotes of the parallel and parses numbers', () => {
    const [first, , second] = result.classes;
    expect([first.parallel, first.level, first.credits]).toEqual(['A', 5, 4]);
    expect([second.parallel, second.credits]).toEqual(['B', 2]);
  });

  it('joins multi-line cells with spaces', () => {
    expect(result.classes[0].teacher).toBe('DOCENTE UNO FICTICIO');
    expect(result.classes[0].department).toBe('TECNOLOGÍAS DE LA INFORMACIÓN Y COMUNICACIÓN');
    expect(result.classes[3].subject).toBe('MATERIA FICTICIA TRES CON UN NOMBRE LARGO (ABC)');
  });

  it('reads room code, wrapped type and floor from the ambient text', () => {
    expect(result.classes[0]).toMatchObject({ roomCode: '1-59-1-03-LC', roomType: 'LABORATORIO DE COMPUTACION', floor: '1' });
    expect(result.classes[2]).toMatchObject({ roomCode: '1-59-2-02-A', roomType: 'AULA', floor: '2' });
  });

  it('cleans the place: empty parentheses and a repeated faculty name are dropped', () => {
    expect(result.classes[0].place).toBe('FACULTAD DE CIENCIAS INFORMÁTICAS');
    expect(result.classes[1].place).toBe('FACULTAD DE CIENCIAS INFORMÁTICAS');
  });

  it('maps a dash department to null', () => {
    expect(result.classes[2].department).toBeNull();
    expect(result.classes[3].department).toBeNull();
  });

  it('ignores the legend table, the footer and the student block', () => {
    const everything = JSON.stringify(result);
    for (const noise of ['APROBADO', 'PENDIENTE', 'LEYENDA', 'Sistema de Gestión', 'FICTICIO UNO', '0000000000']) {
      expect(everything).not.toContain(noise);
    }
  });
});

describe('parseSgaSchedule edge cases', () => {
  it('copes with a department column that has no items at all', () => {
    const pages = [
      page({
        n: 1,
        of: 1,
        first: true,
        headerTop: 373.4,
        courses: [{ subject: ['MATERIA SIN DEPARTAMENTO'], entries: [LAB] }],
      }),
    ];
    const [cls] = parseSgaSchedule(pages).classes;
    expect(cls).toMatchObject({ subject: 'MATERIA SIN DEPARTAMENTO', teacher: 'DOCENTE UNO FICTICIO', department: null, parallel: 'A' });
  });

  it('understands accents, lower case and every day name', () => {
    const entries: Entry[] = [
      { day: 'LUNES', time: '07:00:00-08:00:00' },
      { day: 'MIÉRCOLES', time: '07:00:00-08:00:00' },
      { day: 'Sábado', time: '07:00:00-08:00:00' },
      { day: 'DOMINGO', time: '07:00-08:00' },
      { day: 'VIERNES', time: '07:00:00-08:00:00' },
    ];
    const pages = [page({ n: 1, of: 1, first: true, headerTop: 373.4, courses: [{ subject: ['MATERIA'], entries }] })];
    expect(parseSgaSchedule(pages).classes.map((c) => c.weekday)).toEqual([1, 3, 6, 7, 5]);
  });

  it('warns about a course without schedule and keeps the others', () => {
    const pages = [
      page({
        n: 1,
        of: 1,
        first: true,
        headerTop: 373.4,
        courses: [
          { subject: ['MATERIA CON HORARIO'], entries: [LAB] },
          { subject: ['MATERIA SIN HORARIO'], entries: [] },
        ],
      }),
    ];
    const result = parseSgaSchedule(pages);
    expect(result.classes.map((c) => c.subject)).toEqual(['MATERIA CON HORARIO']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('MATERIA SIN HORARIO');
  });

  it('attaches lines with no subject (a cell split by the page break) to the previous row', () => {
    const first = page({ n: 1, of: 2, first: true, headerTop: 373.4, courses: [{ subject: ['MATERIA PARTIDA'], entries: [LAB] }] });
    // The second entry of the same course continues at the top of page 2, right under the repeated header.
    const continuation = scheduleLines([{ day: 'JUEVES', time: '10:00:00-12:00:00', code: '1-59-2-04-LC', floor: '2' }]);
    const items: PdfTextItem[] = [...header(566.7), ...footer(2, 2)];
    continuation.forEach((line, i) => line.forEach(([x, text]) => items.push(t(x, 535 - i * PITCH, text))));
    const result = parseSgaSchedule([first, { items }]);
    expect(result.classes.map((c) => [c.subject, c.weekday, c.startTime])).toEqual([
      ['MATERIA PARTIDA', 2, '07:00'],
      ['MATERIA PARTIDA', 4, '10:00'],
    ]);
  });

  it('separates two courses whose rows are padded too tightly to show a gap', () => {
    const items: PdfTextItem[] = [...header(373.4)];
    // Row A: four schedule lines at 330..294 with the subject in the middle; row B starts only 14 below.
    const rowA = scheduleLines([{ day: 'LUNES', time: '07:00:00-09:00:00', code: 'A-1', floor: '1' }]); // 5 lines
    const rowB = scheduleLines([{ day: 'MARTES', time: '09:00:00-11:00:00', code: 'B-2', floor: '2' }]);
    rowA.forEach((line, i) => line.forEach(([x, text]) => items.push(t(x, 330 - i * PITCH, text))));
    rowB.forEach((line, i) => line.forEach(([x, text]) => items.push(t(x, 330 - 4 * PITCH - 14 - i * PITCH, text))));
    items.push(t(26.3, 306, 'PRIMERA MATERIA'), t(229.8, 306, '5', 4.2), t(263.8, 306, '"A"', 12.4), t(305.7, 306, '3', 4.2));
    const bCenter = 330 - 4 * PITCH - 14 - 2 * PITCH;
    items.push(t(26.3, bCenter, 'SEGUNDA MATERIA'), t(229.8, bCenter, '5', 4.2), t(263.8, bCenter, '"B"', 12.4), t(305.7, bCenter, '4', 4.2));
    const result = parseSgaSchedule([{ items }]);
    expect(result.classes.map((c) => [c.subject, c.parallel, c.weekday, c.roomCode])).toEqual([
      ['PRIMERA MATERIA', 'A', 1, 'A-1'],
      ['SEGUNDA MATERIA', 'B', 2, 'B-2'],
    ]);
  });

  it('reads the period when the label and the value come as one item', () => {
    const pages = [page({ n: 1, of: 1, headerTop: 373.4, courses: [{ subject: ['MATERIA'], entries: [LAB] }] })];
    pages[0].items.push(t(139.9, 489.1, 'Período: MARZO 2027 - JULIO 2027 (PREGRADO)'));
    const result = parseSgaSchedule(pages);
    expect(result.periodLabel).toBe('MARZO 2027 - JULIO 2027 (PREGRADO)');
    expect(result.periodEnd).toBe('2027-07-31');
  });

  it('never throws on odd input', () => {
    const odd = [
      [],
      [{ items: [] }],
      [{ items: [t(1, 2, 'texto suelto')] }],
      [{ items: [{ str: 'ASIGNATURA', x: Number.NaN, y: 1, width: 1 }] }],
      [{} as PdfPageText],
      [null as unknown as PdfPageText],
    ];
    for (const pages of odd) {
      const result = parseSgaSchedule(pages);
      expect(result.classes).toEqual([]);
      expect(Array.isArray(result.warnings)).toBe(true);
    }
    expect(parseSgaSchedule(undefined as unknown as PdfPageText[]).classes).toEqual([]);
    expect(parseSgaSchedule([{ items: [t(1, 2, 'texto suelto')] }]).warnings[0]).toMatch(/tabla/i);
  });

  it('drops entries with an impossible time range', () => {
    expect(parseScheduleCell('LUNES (09:00:00-07:00:00) LUGAR: AULA 1 COD. AMB.: X; TIPO: AULA; PISO: 1;')).toEqual([]);
    expect(parseScheduleCell('LUNES (25:00:00-26:00:00)')).toEqual([]);
  });
});

describe('parseScheduleCell', () => {
  it('splits several entries and tolerates missing seconds and fields', () => {
    const entries = parseScheduleCell(
      'MARTES (07:00-09:00) LUGAR: EDIFICIO A COD. AMB.: 1-1-1; TIPO: AULA; PISO: 2; VIERNES (10:00:00-12:00:00)',
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      weekday: 2,
      startTime: '07:00',
      endTime: '09:00',
      place: 'EDIFICIO A',
      roomCode: '1-1-1',
      roomType: 'AULA',
      floor: '2',
    });
    expect(entries[1]).toEqual({ weekday: 5, startTime: '10:00', endTime: '12:00', place: null, roomCode: null, roomType: null, floor: null });
  });
});

describe('parsePeriodEnd', () => {
  it('returns the last day of the last month named', () => {
    expect(parsePeriodEnd('SEPTIEMBRE 2026 - ENERO 2027')).toBe('2027-01-31');
    expect(parsePeriodEnd('SEPTIEMBRE 2026 - ENERO 2027 (PREGRADO)')).toBe('2027-01-31');
    expect(parsePeriodEnd('MARZO 2024 - JUNIO 2024')).toBe('2024-06-30');
    expect(parsePeriodEnd('Octubre 2026 - Febrero 2028')).toBe('2028-02-29');
    expect(parsePeriodEnd('MAYO 2026 - SETIEMBRE 2026')).toBe('2026-09-30');
  });

  it('is null when nothing readable is there', () => {
    expect(parsePeriodEnd(null)).toBeNull();
    expect(parsePeriodEnd('')).toBeNull();
    expect(parsePeriodEnd('PERIODO ACTUAL')).toBeNull();
  });
});
