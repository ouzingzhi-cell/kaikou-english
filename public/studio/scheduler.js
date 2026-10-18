/** Calendar rules for the English practice studio. Dates are local YYYY-MM-DD keys. */
const REVIEW_OFFSETS = [0, 1, 3, 7];

function calendarDate(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw new TypeError('日期必须使用 YYYY-MM-DD 格式。');
  }
  const [year, month, day] = key.split('-').map(Number);
  // Local noon avoids daylight-saving transitions around midnight. setFullYear
  // also handles years 0000–0099 without the Date constructor's 1900 offset.
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new RangeError(`无效的日历日期：${key}`);
  }
  return date;
}

/** Keep a date-only string in the user's calendar instead of parsing it as UTC. */
export function toDateKey(value = new Date()) {
  if (typeof value === 'string') {
    calendarDate(value);
    return value;
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError('请传入有效 Date 或 YYYY-MM-DD 日期。');
  }
  return `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function shiftDate(dateKey, days) {
  if (!Number.isSafeInteger(days)) throw new TypeError('天数必须是整数。');
  const date = calendarDate(toDateKey(dateKey));
  date.setDate(date.getDate() + days);
  if (Number.isNaN(date.getTime())) throw new RangeError('日期超出了可支持的范围。');
  return toDateKey(date);
}

export function isWeekend(dateKey) {
  const day = calendarDate(toDateKey(dateKey)).getDay();
  return day === 0 || day === 6;
}

/** Monday through Sunday of the ISO calendar week containing dateKey. */
export function getWeekDays(dateKey) {
  const key = toDateKey(dateKey);
  const weekday = calendarDate(key).getDay();
  const monday = shiftDate(key, -((weekday + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => shiftDate(monday, index));
}

/**
 * history is the dated study log, not the generated plan. Each record is
 * { date, lessonId, dialogueId?, title?, completed? }. A pending item can be
 * explicitly added for today (-0); missed plans should not be logged as studied.
 * Exact calendar dates stay empty when no content was studied on that date.
 */
export function getReviewBuckets(dateKey, history = []) {
  const today = toDateKey(dateKey);
  return REVIEW_OFFSETS.map((offset) => {
    const date = shiftDate(today, -offset);
    return {
      offset,
      date,
      label: `-${offset}`,
      basis: 'actual-study-date',
      items: history.filter((record) => record.date === date).map((record) => ({ ...record })),
    };
  });
}

function hashSeed(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * completedLessonIds explicitly means complete topics (all five dialogues),
 * as of dateKey. At least 11 distinct complete topics with an actual, non-future
 * study record are required. Pending/planned records never establish eligibility.
 * A fixed learned set draws the same two topics throughout the ISO week.
 * Persist the first draw by weekKey in the app if the learned set grows midweek.
 */
export function getWeeklyRandomReviews(dateKey, history = [], completedLessonIds = []) {
  const today = toDateKey(dateKey);
  const weekKey = getWeekDays(today)[0];
  const actualRecords = new Map();
  for (const record of history) {
    if (record.kind === 'planned' || record.completed === false || !record.date || record.date > today) continue;
    // Validate input dates before allowing them to establish completed study.
    toDateKey(record.date);
    const key = String(record.lessonId);
    if (!actualRecords.has(key)) actualRecords.set(key, record);
  }
  const uniqueCompleted = new Map();
  for (const lessonId of completedLessonIds) {
    const key = String(lessonId);
    if (actualRecords.has(key) && !uniqueCompleted.has(key)) uniqueCompleted.set(key, lessonId);
  }
  if (uniqueCompleted.size < 11) return [];

  const pool = [...uniqueCompleted.values()].sort((left, right) => {
    const a = String(left);
    const b = String(right);
    const numericA = Number(a);
    const numericB = Number(b);
    if (Number.isFinite(numericA) && Number.isFinite(numericB)) return numericA - numericB;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const random = seededRandom(hashSeed(weekKey));
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [pool[index], pool[target]] = [pool[target], pool[index]];
  }
  return pool.slice(0, 2).map((lessonId) => ({
    lessonId,
    title: `第 ${lessonId} 课`,
    weekKey,
    kind: 'weekly-random',
    basis: 'actual-completion',
  }));
}

/**
 * The agreed cadence is one topic / five dialogues on each weekday (20 days).
 * These rows express a plan; only actual study should create history records.
 * The optional dialogue cadence spreads 100 dialogues across 100 weekdays.
 */
export function buildStudyPlan(startDate, cadence = 'lesson', totalLessons = 20) {
  if (cadence !== 'lesson' && cadence !== 'dialogue') {
    throw new TypeError('学习节奏必须为 lesson 或 dialogue。');
  }
  if (!Number.isSafeInteger(totalLessons) || totalLessons < 0) {
    throw new TypeError('主题课数量必须为非负整数。');
  }
  let date = toDateKey(startDate);
  const totalRows = totalLessons * (cadence === 'dialogue' ? 5 : 1);
  const rows = [];
  for (let index = 0; index < totalRows; index += 1) {
    while (isWeekend(date)) date = shiftDate(date, 1);
    const lessonId = cadence === 'dialogue' ? Math.floor(index / 5) + 1 : index + 1;
    rows.push({
      date,
      lessonId,
      ...(cadence === 'dialogue' ? { dialogueId: index % 5 + 1 } : { dialogueIds: [1, 2, 3, 4, 5] }),
      kind: 'planned',
    });
    date = shiftDate(date, 1);
  }
  return rows;
}
