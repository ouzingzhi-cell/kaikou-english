import { toDateKey, shiftDate, isWeekend } from './scheduler.js';

/** Required tasks are explicit: an empty review day can be completed as empty. */
export function getCheckinEligibility(dateKey, { newDone = false, reviewDone = false, hasNewLesson = true, hasReview = true } = {}, todayKey = toDateKey(new Date())) {
  const date = toDateKey(dateKey), today = toDateKey(todayKey), weekend = isWeekend(date);
  const required = [...(!weekend && hasNewLesson ? ['new'] : []), ...(hasReview ? ['review'] : [])];
  const missing = required.filter(item => item === 'new' ? !newDone : !reviewDone);
  const isFuture = date > today;
  return {
    date, eligible: !isFuture && missing.length === 0, isWeekend: weekend, required, missing, isFuture,
    reason: isFuture ? '未来日期不能提前打卡。' : missing.length ? `完成${missing.map(item => item === 'new' ? '当天新课' : '当天复习').join('和')}后即可打卡。` : '今天的学习任务已完成，可以打卡。',
  };
}

/** A fixed Monday-first, six-row calendar; checkins are keyed by local date. */
export function getMonthGrid(monthKey, checkins = {}, todayKey = toDateKey(new Date())) {
  if (typeof monthKey !== 'string' || !/^\d{4}-\d{2}$/.test(monthKey)) throw new TypeError('月份须使用 YYYY-MM 格式。');
  const first = `${monthKey}-01`;
  toDateKey(first);
  const today = toDateKey(todayKey);
  const weekday = new Date(`${first}T12:00:00`).getDay();
  const start = shiftDate(first, -((weekday + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => {
    const date = shiftDate(start, index);
    return { date, day: Number(date.slice(-2)), inMonth: date.startsWith(`${monthKey}-`), isToday: date === today, isFuture: date > today, isWeekend: isWeekend(date), checked: Boolean(checkins[date]) };
  });
}
