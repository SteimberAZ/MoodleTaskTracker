import { scopedQuery } from './queries';

/** Pure grade computation: no I/O, no React. The server read lives in `grades-store.ts`. */

export const PASS_MARK = 70;
export const COURSE_POINTS = 100;
/** Needing more than this share of the points still to grade puts a course at risk. */
export const AT_RISK_SHARE = 0.7;

export const GRADE_ITEM_COLUMNS =
  'course_id,item_id,course_name,item_name,item_type,item_module,cmid,item_instance,category_id,sort_order,report_depth,grade_raw,grade_min,grade_max,grade_formatted,percentage_formatted,weight_raw,graded_at,fetched_at';

export interface GradeItemRow {
  course_id: number;
  item_id: number;
  course_name: string;
  item_name: string | null;
  item_type: string;
  item_module: string | null;
  cmid: number | null;
  item_instance: number | null;
  category_id: number | null;
  sort_order: number;
  report_depth: number | null;
  grade_raw: number | null;
  grade_min: number | null;
  grade_max: number | null;
  grade_formatted: string | null;
  percentage_formatted: string | null;
  weight_raw: number | null;
  graded_at: number | null;
  fetched_at: string | null;
}

export type StandingMethod = 'weights' | 'points' | 'estimate' | 'none';
export type StandingStatus = 'passed' | 'on_track' | 'at_risk' | 'lost' | 'unknown' | 'no_grades';

export interface GradedItem {
  itemId: number;
  name: string;
  module: string | null;
  grade: number;
  min: number;
  max: number | null;
  /** Points this item adds to the 100-point total; null for an estimate. */
  contribution: number | null;
  gradedAt: number | null;
}

export interface CourseStanding {
  courseId: number;
  courseName: string;
  method: StandingMethod;
  estimate: boolean;
  earned: number;
  spent: number | null;
  available: number | null;
  needed: number;
  maxReachable: number | null;
  reachable: boolean | null;
  passed: boolean;
  neededShare: number | null;
  status: StandingStatus;
  graded: GradedItem[];
  pendingItems: number;
  fetchedAt: string | null;
}

export interface StandingsSummary {
  total: number;
  passed: number;
  onTrack: number;
  atRisk: number;
  noData: number;
}

export function gradeItemsPath(userId: string): string {
  return `moodle_grade_items${scopedQuery(
    userId,
    `select=${GRADE_ITEM_COLUMNS}`,
    'order=course_name.asc,course_id.asc,sort_order.asc',
    'limit=3000',
  )}`;
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function toNum(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const toStr = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Validates and coerces the PostgREST answer; malformed rows are dropped instead of crashing the page. */
export function parseGradeRows(raw: unknown): GradeItemRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: GradeItemRow[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const r = entry as Record<string, unknown>;
    const courseId = toInt(r.course_id);
    const itemId = toInt(r.item_id);
    if (courseId === null || itemId === null || typeof r.item_type !== 'string') continue;
    rows.push({
      course_id: courseId,
      item_id: itemId,
      course_name: toStr(r.course_name) ?? '',
      item_name: toStr(r.item_name),
      item_type: r.item_type,
      item_module: toStr(r.item_module),
      cmid: toNum(r.cmid),
      item_instance: toNum(r.item_instance),
      category_id: toNum(r.category_id),
      sort_order: toNum(r.sort_order) ?? 0,
      report_depth: toNum(r.report_depth),
      grade_raw: toNum(r.grade_raw),
      grade_min: toNum(r.grade_min),
      grade_max: toNum(r.grade_max),
      grade_formatted: toStr(r.grade_formatted),
      percentage_formatted: toStr(r.percentage_formatted),
      weight_raw: toNum(r.weight_raw),
      graded_at: toNum(r.graded_at),
      fetched_at: toStr(r.fetched_at),
    });
  }
  return rows;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Points with a decimal comma, as shown in the UI (17 -> '17', 8.5 -> '8,5'). */
export function formatPoints(n: number): string {
  return String(round2(n)).replace('.', ',');
}

const range = (r: GradeItemRow): number => (r.grade_max ?? NaN) - (r.grade_min ?? 0);
const isLeaf = (r: GradeItemRow): boolean => r.item_type === 'mod' || r.item_type === 'manual';
const isGraded = (r: GradeItemRow): boolean => r.grade_raw !== null;

interface Computation {
  method: StandingMethod;
  earned: number;
  spent: number | null;
  available: number | null;
  /** Unrounded contribution per graded item id (empty for an estimate). */
  contributions: Map<number, number>;
}

/** Method 1: Moodle weights, only while they are complete and were not renormalized over the graded items. */
function byWeights(rows: GradeItemRow[], leaves: GradeItemRow[], courseRow: GradeItemRow | undefined): Computation | null {
  if (leaves.length === 0) return null;
  if (rows.some((r) => r.report_depth !== null && r.report_depth > 3)) return null;

  const categoryWeight = new Map<number, number | null>();
  for (const r of rows) {
    if (r.item_type === 'category' && r.item_instance !== null) categoryWeight.set(r.item_instance, r.weight_raw);
  }

  const weights = new Map<number, number>();
  let sum = 0;
  for (const leaf of leaves) {
    if (leaf.weight_raw === null || leaf.weight_raw < 0 || !(range(leaf) > 0)) return null;
    if (!isGraded(leaf) && !(leaf.weight_raw > 0)) return null;
    let parent = 1;
    if (leaf.category_id !== null && leaf.category_id !== (courseRow?.item_instance ?? null)) {
      const w = categoryWeight.get(leaf.category_id);
      if (w === undefined || w === null) return null;
      parent = w;
    }
    const w = leaf.weight_raw * parent;
    weights.set(leaf.item_id, w);
    sum += w;
  }
  if (Math.abs(sum - 1) > 0.02) return null;

  const contributions = new Map<number, number>();
  let earned = 0;
  let spent = 0;
  for (const leaf of leaves) {
    if (!isGraded(leaf)) continue;
    const w = weights.get(leaf.item_id) ?? 0;
    const fraction = Math.max(0, ((leaf.grade_raw as number) - (leaf.grade_min ?? 0)) / range(leaf));
    const c = w * fraction * COURSE_POINTS;
    contributions.set(leaf.item_id, c);
    earned += c;
    spent += w * COURSE_POINTS;
  }
  const spentR = round2(spent);
  return { method: 'weights', earned, spent: spentR, available: Math.max(0, round2(COURSE_POINTS - spentR)), contributions };
}

/** Method 2: the activity maxima add up to about 100, so each grade point is one course point. */
function byPoints(leaves: GradeItemRow[]): Computation | null {
  if (leaves.length === 0 || leaves.some((l) => !(range(l) > 0))) return null;
  const total = leaves.reduce((acc, l) => acc + range(l), 0);
  if (Math.abs(total - COURSE_POINTS) > 1) return null;
  const scale = COURSE_POINTS / total;

  const contributions = new Map<number, number>();
  let earned = 0;
  let spent = 0;
  for (const leaf of leaves) {
    if (!isGraded(leaf)) continue;
    const c = Math.max(0, (leaf.grade_raw as number) - (leaf.grade_min ?? 0)) * scale;
    contributions.set(leaf.item_id, c);
    earned += c;
    spent += range(leaf) * scale;
  }
  const spentR = round2(spent);
  return { method: 'points', earned, spent: spentR, available: Math.max(0, round2(COURSE_POINTS - spentR)), contributions };
}

/** Method 3: the course total scaled to 100; the weighting is unknown, so no projection is made. */
function byEstimate(courseRow: GradeItemRow | undefined): Computation | null {
  if (!courseRow || courseRow.grade_raw === null || !(range(courseRow) > 0)) return null;
  const earned = Math.max(0, ((courseRow.grade_raw - (courseRow.grade_min ?? 0)) / range(courseRow)) * COURSE_POINTS);
  return { method: 'estimate', earned, spent: null, available: null, contributions: new Map() };
}

function compareGraded(a: GradeItemRow, b: GradeItemRow): number {
  const ga = a.graded_at;
  const gb = b.graded_at;
  if (ga !== gb) {
    if (ga === null) return 1;
    if (gb === null) return -1;
    return gb - ga;
  }
  return a.sort_order - b.sort_order;
}

export function latestFetch(rows: GradeItemRow[]): string | null {
  let best: string | null = null;
  let bestTime = -Infinity;
  for (const r of rows) {
    if (r.fetched_at === null) continue;
    const t = Date.parse(r.fetched_at);
    if (Number.isNaN(t)) continue;
    if (t > bestTime) {
      bestTime = t;
      best = r.fetched_at;
    }
  }
  return best;
}

/** Standing of ONE course: pass `rows` that all belong to the same `course_id`. */
export function computeCourseStanding(rows: GradeItemRow[]): CourseStanding {
  const leaves = rows.filter(isLeaf);
  const courseRow = rows.find((r) => r.item_type === 'course');
  const gradedLeaves = leaves.filter(isGraded);

  const computation: Computation = byWeights(rows, leaves, courseRow) ??
    byPoints(leaves) ??
    byEstimate(courseRow) ?? { method: 'none', earned: 0, spent: null, available: null, contributions: new Map() };

  const earned = round2(computation.earned);
  const needed = round2(Math.max(0, PASS_MARK - earned));
  const pendingItems = leaves.length - gradedLeaves.length;
  // An estimate is Moodle's course total, which is renormalized over the graded items; it cannot confirm a pass
  // while any stored activity is still ungraded.
  const passed = earned >= PASS_MARK && (computation.method !== 'estimate' || pendingItems === 0);
  const projected = computation.method === 'weights' || computation.method === 'points';
  const spent = computation.spent === null ? null : round2(computation.spent);
  const available = computation.available === null ? null : round2(computation.available);
  const maxReachable = projected && available !== null ? round2(earned + available) : null;
  const reachable = maxReachable === null ? null : maxReachable >= PASS_MARK;
  const neededShare = projected && available !== null && available > 0 ? needed / available : null;

  let status: StandingStatus;
  if (passed) status = 'passed';
  else if (!projected) status = gradedLeaves.length > 0 || (courseRow !== undefined && isGraded(courseRow)) ? 'unknown' : 'no_grades';
  else if (gradedLeaves.length === 0) status = 'no_grades';
  else if (reachable === false) status = 'lost';
  else if (neededShare !== null && neededShare > AT_RISK_SHARE) status = 'at_risk';
  else status = 'on_track';

  const graded: GradedItem[] = [...gradedLeaves].sort(compareGraded).map((leaf) => {
    const c = computation.contributions.get(leaf.item_id);
    return {
      itemId: leaf.item_id,
      name: leaf.item_name || 'Actividad sin nombre',
      module: leaf.item_module,
      grade: leaf.grade_raw as number,
      min: leaf.grade_min ?? 0,
      max: leaf.grade_max,
      contribution: c === undefined ? null : round2(c),
      gradedAt: leaf.graded_at,
    };
  });

  return {
    courseId: rows[0]?.course_id ?? 0,
    courseName: rows[0]?.course_name ?? '',
    method: computation.method,
    estimate: computation.method === 'estimate',
    earned,
    spent,
    available,
    needed,
    maxReachable,
    reachable,
    passed,
    neededShare,
    status,
    graded,
    pendingItems,
    fetchedAt: latestFetch(rows),
  };
}

const STATUS_RANK: Record<StandingStatus, number> = {
  lost: 0,
  at_risk: 1,
  on_track: 2,
  unknown: 3,
  no_grades: 4,
  passed: 5,
};

/** One standing per course, the ones needing attention first. */
export function buildStandings(rows: GradeItemRow[]): CourseStanding[] {
  const byCourse = new Map<number, GradeItemRow[]>();
  for (const r of rows) {
    const list = byCourse.get(r.course_id);
    if (list) list.push(r);
    else byCourse.set(r.course_id, [r]);
  }
  return [...byCourse.values()]
    .map(computeCourseStanding)
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.courseName.localeCompare(b.courseName, 'es'));
}

export function summarizeStandings(list: CourseStanding[]): StandingsSummary {
  const count = (...statuses: StandingStatus[]) => list.filter((s) => statuses.includes(s.status)).length;
  return {
    total: list.length,
    passed: count('passed'),
    onTrack: count('on_track'),
    atRisk: count('at_risk', 'lost'),
    noData: count('unknown', 'no_grades'),
  };
}
