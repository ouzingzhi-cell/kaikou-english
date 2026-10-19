import {isWeekend, shiftDate, getWeekDays, getWeeklyRandomReviews, toDateKey} from './scheduler.js';

const OFFSETS = [0,1,3,7];
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const dialogueKey = (lessonId, index) => `${Number(lessonId)}:${index}`;
const allStages = stages => Array.from({length:9}, (_, i) => i).every(i => stages?.includes(i));
function validDate(value) { try { return typeof value === 'string' ? toDateKey(value) : null; } catch { return null; } }
function identity(lessonId, dialogueIndex) {
  const id = Number(lessonId);
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isInteger(dialogueIndex) || dialogueIndex < 0 || dialogueIndex > 4) throw new RangeError('课号或对话序号无效。');
  return id;
}
function rowIndex(row) {
  if (Number.isInteger(row.dialogueIndex) && row.dialogueIndex >= 0 && row.dialogueIndex < 5) return row.dialogueIndex;
  const match = /^\d+\.([1-5])$/.exec(String(row.dialogueId || ''));
  if (match) return Number(match[1]) - 1;
  if (/^[1-5]$/.test(String(row.dialogueId || ''))) return Number(row.dialogueId) - 1;
  return null;
}
function completionRecord({lessonId, dialogueIndex, date, title, dialogueTitle, ...extra}) {
  return {...extra, lessonId:Number(lessonId), dialogueIndex, dialogueId:`${Number(lessonId)}.${dialogueIndex+1}`,
    title:dialogueTitle || `对话 ${dialogueIndex+1}`, lessonTitle:title || `第 ${lessonId} 课`, date, completed:true};
}

function migrateCompletions(store) {
  const add = (lessonId, index, date, row, basis, inferred) => {
    if (!validDate(date) || !Number.isSafeInteger(Number(lessonId)) || Number(lessonId) < 1) return;
    const key = dialogueKey(lessonId,index), previous = store.dialogueCompletions[key];
    if (previous && (!previous.dateInferred && inferred || previous.dateInferred === inferred && previous.date <= date)) return;
    store.dialogueCompletions[key] = completionRecord({lessonId,dialogueIndex:index,date,
      title:row.lessonTitle || (rowIndex(row) === null ? row.title : undefined),
      dialogueTitle:rowIndex(row) === index ? row.dialogueTitle || row.title : undefined,
      migrationBasis:basis,dateInferred:inferred});
  };
  // Dated old progress keys provide the earliest day on which all nine stages existed.
  const dated = new Map();
  for (const [key, stages] of Object.entries(store.progress)) {
    const match = /^(\d{4}-\d{2}-\d{2}):(\d+):([0-4])$/.exec(key);
    if (!match || !validDate(match[1])) continue;
    const target = dialogueKey(match[2],Number(match[3]));
    if (!dated.has(target)) dated.set(target,[]);
    dated.get(target).push({date:match[1],stages});
  }
  for (const [key, stages] of Object.entries(store.progress)) {
    const match = /^(\d+):([0-4])$/.exec(key);
    if (!match || !allStages(stages)) continue;
    const lessonId = Number(match[1]), index = Number(match[2]);
    const row = store.history.find(item => Number(item.lessonId) === lessonId && rowIndex(item) === index)
      || store.history.find(item => Number(item.lessonId) === lessonId && rowIndex(item) === null && item.kind !== 'planned') || {};
    let date, accumulated = [];
    for (const event of (dated.get(key) || []).sort((a,b)=>a.date.localeCompare(b.date))) {
      accumulated = [...new Set([...accumulated,...event.stages])];
      if (allStages(accumulated)) { date = event.date; break; }
    }
    const inferred = !date;
    date ||= validDate(row.completedAt) || validDate(row.lastStudiedAt) || validDate(row.date);
    add(lessonId,index,date,row,'legacy-nine-stages',inferred);
  }
  for (const row of store.history) {
    if (!row.completed || row.kind === 'planned') continue;
    const index = rowIndex(row), date = validDate(row.completedAt) || validDate(row.date);
    for (const i of index === null ? [0,1,2,3,4] : [index]) add(row.lessonId,i,date,row,'legacy-completed-record',index === null);
  }
}

export function createStore(saved = {}) {
  const progress = Object.fromEntries(Object.entries(saved.progress || {}).map(([key,value])=>[key,Array.isArray(value)?[...value]:[]]));
  for (const [key,value] of Object.entries(progress)) {
    const old = /^\d{4}-\d{2}-\d{2}:(\d+):([0-4])$/.exec(key);
    if (old) progress[`${old[1]}:${old[2]}`] = [...new Set([...(progress[`${old[1]}:${old[2]}`] || []),...value])];
  }
  const store = {version:3,progress,history:(saved.history || []).map(row=>({...row})),reviewDone:{...saved.reviewDone},
    weeklyDraws:structuredClone(saved.weeklyDraws || {}),checkins:structuredClone(saved.checkins || {}),dialogueCompletions:{},
    startDate:saved.startDate || '',selectedLesson:saved.selectedLesson || saved.history?.[0]?.lessonId || 1,
    accent:'en-US',noiseScene:saved.noiseScene || 'restaurant',noiseVolume:saved.noiseVolume ?? 25};
  if (!own(saved,'dialogueCompletions')) migrateCompletions(store);
  else for (const [key,value] of Object.entries(saved.dialogueCompletions || {})) {
    const match = /^(\d+):([0-4])$/.exec(key);
    if (!match || !value?.completed || !validDate(value.date)) continue;
    const lessonId=Number(match[1]),dialogueIndex=Number(match[2]);
    store.dialogueCompletions[dialogueKey(lessonId,dialogueIndex)] = {...value,lessonId,dialogueIndex,dialogueId:`${lessonId}.${dialogueIndex+1}`};
  }
  // Freeze the scope of old whole-topic flags now; later completed dialogues must not inherit them.
  if (!own(saved,'dialogueCompletions')) for (const [key,done] of Object.entries(store.reviewDone)) {
    if (!done) continue;
    const regular = /^(\d{4}-\d{2}-\d{2}):(\d+):(0|1|3|7)$/.exec(key);
    const weekly = /^weekly:(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(key);
    if (regular && validDate(regular[1])) for (const i of reviewDialogueIndices(store,regular[2],regular[1],Number(regular[3]))) store.reviewDone[`${key}:${i}`] = true;
    if (weekly && validDate(weekly[1])) for (const i of reviewDialogueIndices(store,weekly[2],shiftDate(weekly[1],6),'weekly')) store.reviewDone[`${key}:${i}`] = true;
  }
  return store;
}

export function clearLearningRecords(store) {
  return {...store,progress:{},history:[],dialogueCompletions:{},reviewDone:{},weeklyDraws:{},checkins:{}};
}
export function progressKey(lessonId, dialogueIndex, review = null) {
  return review ? `review:${review.dueDate}:${lessonId}:${review.offset}:${dialogueIndex}` : dialogueKey(lessonId,dialogueIndex);
}
export function getStages(store, lessonId, dialogueIndex, review = null) { return store.progress[progressKey(lessonId,dialogueIndex,review)] || []; }
export const reviewKey = (date, lessonId, offset) => `${date}:${Number(lessonId)}:${offset}`;
function doneKey(date,lessonId,offset,index) {
  const base = offset === 'weekly' ? `weekly:${getWeekDays(date)[0]}:${Number(lessonId)}` : reviewKey(date,lessonId,Number(offset));
  return index === undefined ? base : `${base}:${index}`;
}

export function getDialogueCompletion(store,lessonId,dialogueIndex) {
  const row = store.dialogueCompletions?.[dialogueKey(lessonId,dialogueIndex)];
  return row?.completed && validDate(row.date) ? row : null;
}
export function reviewHistory(store) {
  return Object.values(store.dialogueCompletions || {}).filter(row=>row.completed && validDate(row.date))
    .map(row=>({...row})).sort((a,b)=>a.date.localeCompare(b.date) || Number(a.lessonId)-Number(b.lessonId) || a.dialogueIndex-b.dialogueIndex);
}
function completedTopics(store,date) {
  const groups = new Map();
  for (const row of reviewHistory(store)) {
    if (row.date > date) continue;
    if (!groups.has(row.lessonId)) groups.set(row.lessonId,[]);
    groups.get(row.lessonId).push(row);
  }
  return [...groups.entries()].filter(([,rows])=>new Set(rows.map(row=>row.dialogueIndex)).size===5).map(([lessonId,rows])=>({
    lessonId,title:rows[0].lessonTitle,date:rows[0].date,completedAt:rows.at(-1).date,completed:true,
  }));
}
export function completeDialogue(store,{lessonId,title,dialogueIndex,dialogueTitle,date}) {
  lessonId = identity(lessonId,dialogueIndex); date = toDateKey(date);
  const existing = getDialogueCompletion(store,lessonId,dialogueIndex);
  if (existing) return {complete:[0,1,2,3,4].every(i=>getDialogueCompletion(store,lessonId,i)),alreadyCompleted:true,record:existing};
  const record = completionRecord({lessonId,dialogueIndex,date,title,dialogueTitle});
  store.dialogueCompletions ||= {};
  store.dialogueCompletions[dialogueKey(lessonId,dialogueIndex)] = record;
  for (const offset of OFFSETS) delete store.reviewDone[doneKey(shiftDate(date,offset),lessonId,offset)];
  delete store.reviewDone[doneKey(date,lessonId,'weekly')];
  let topic = store.history.find(row=>Number(row.lessonId)===lessonId && rowIndex(row)===null);
  if (!topic) { topic={lessonId,title:title || record.lessonTitle,date,completed:false};store.history.push(topic); }
  topic.lastStudiedAt = date;
  const rows = [0,1,2,3,4].map(i=>getDialogueCompletion(store,lessonId,i));
  topic.completed = rows.every(Boolean);
  if (topic.completed) topic.completedAt = rows.map(row=>row.date).sort().at(-1);
  return {complete:topic.completed,alreadyCompleted:false,record};
}

export function reviewDialogueIndices(store,lessonId,dueDate,offset) {
  const date = toDateKey(dueDate);
  if (offset !== 'weekly' && !OFFSETS.includes(Number(offset))) return [];
  const originalDate = offset === 'weekly' ? null : shiftDate(date,-Number(offset));
  return [0,1,2,3,4].filter(i=>{
    const row=getDialogueCompletion(store,lessonId,i);
    return row && (offset === 'weekly' ? row.date<=date : row.date===originalDate);
  });
}
export function isReviewed(store,date,lessonId,offset,index) {
  const indices = reviewDialogueIndices(store,lessonId,date,offset);
  if (index !== undefined) return indices.includes(index) && store.reviewDone[doneKey(date,lessonId,offset,index)] === true;
  return indices.length ? indices.every(i=>store.reviewDone[doneKey(date,lessonId,offset,i)]===true) : store.reviewDone[doneKey(date,lessonId,offset)]===true;
}
export function markReviewed(store,date,lessonId,offset,index,actualDate=date) {
  date = toDateKey(date);actualDate = toDateKey(actualDate);
  if (date > actualDate) return false;
  const required = reviewDialogueIndices(store,lessonId,date,offset);
  const selected = index === undefined ? required : required.filter(i=>i===index);
  if (index !== undefined && !selected.length) return false;
  const weeklyDrawn = store.weeklyDraws[getWeekDays(actualDate)[0]]?.some(row=>Number(row.lessonId)===Number(lessonId));
  const scopes = [...OFFSETS,...(weeklyDrawn ? ['weekly'] : [])];
  for (const i of selected) {
    store.reviewDone[doneKey(date,lessonId,offset,i)] = true;
    for (const candidate of scopes) {
      if (reviewDialogueIndices(store,lessonId,actualDate,candidate).includes(i)) store.reviewDone[doneKey(actualDate,lessonId,candidate,i)] = true;
    }
  }
  for (const [targetDate,candidate] of [[date,offset],...scopes.map(candidate=>[actualDate,candidate])]) {
    const indices=reviewDialogueIndices(store,lessonId,targetDate,candidate);
    if (indices.length && indices.every(i=>store.reviewDone[doneKey(targetDate,lessonId,candidate,i)])) store.reviewDone[doneKey(targetDate,lessonId,candidate)] = true;
  }
  // Keep the legacy empty-item flag for callers of the old stage API only.
  if (index === undefined && !required.length) store.reviewDone[doneKey(date,lessonId,offset)] = true;
  return true;
}

/** Legacy stage completion remains available; the new UI uses completeDialogue explicitly. */
export function completeStage(store,{lessonId,title,dialogueIndex,stage,date,review=null}) {
  const key=progressKey(lessonId,dialogueIndex,review);
  store.progress[key]=[...new Set([...(store.progress[key] || []),stage])];
  if (review) {
    const complete=[0,1,2,3,4].every(i=>{const stages=getStages(store,lessonId,i,review);return stages.includes(7)&&stages.includes(8);});
    if (complete) markReviewed(store,review.dueDate,lessonId,review.offset);
    return {complete,review:true};
  }
  let record=store.history.find(row=>Number(row.lessonId)===Number(lessonId) && rowIndex(row)===null);
  if (isWeekend(date)&&!record) return {complete:false,weekend:true};
  if (!record) { record={date,lessonId,title,completed:false};store.history.push(record); }
  record.lastStudiedAt=date;
  if (allStages(getStages(store,lessonId,dialogueIndex))) completeDialogue(store,{lessonId,title,dialogueIndex,date});
  record.completed=[0,1,2,3,4].every(i=>getDialogueCompletion(store,lessonId,i));
  if (record.completed) { record.completedAt ||= date;markReviewed(store,record.date,lessonId,0); }
  return {complete:record.completed,record};
}
export function learnedIds(store,date) { return completedTopics(store,toDateKey(date)).map(row=>row.lessonId).sort((a,b)=>a-b); }
export function weeklyReviews(store,date,today=date) {
  const topics=completedTopics(store,toDateKey(date)),ids=topics.map(row=>row.lessonId);
  if (ids.length<11) return [];
  const week=getWeekDays(date)[0];
  if (store.weeklyDraws[week]) { const eligible=new Set(ids.map(String));return store.weeklyDraws[week].filter(row=>eligible.has(String(row.lessonId))); }
  const draw=getWeeklyRandomReviews(date,topics,ids);
  if (date<=today&&draw.length) store.weeklyDraws[week]=draw;
  return draw;
}
export function overdueReviews(store,date) {
  toDateKey(date);
  const rows=[];
  for (const record of reviewHistory(store)) for (const offset of OFFSETS) {
    const dueDate=shiftDate(record.date,offset);
    if (dueDate<date&&!isReviewed(store,dueDate,record.lessonId,offset,record.dialogueIndex)) rows.push({...record,dueDate,offset});
  }
  return rows.sort((a,b)=>a.dueDate.localeCompare(b.dueDate)||a.lessonId-b.lessonId||a.dialogueIndex-b.dialogueIndex||a.offset-b.offset);
}
export function dailyLesson(store,date,total=20) {
  if (isWeekend(date)||store.startDate&&date<store.startDate) return null;
  const topics=completedTopics(store,date),finishedToday=topics.find(row=>row.completedAt===date);
  if (finishedToday) return {lessonId:finishedToday.lessonId,resume:false,completed:true};
  const completed=new Set(topics.map(row=>row.lessonId));
  const pending=[...store.history,...reviewHistory(store)].filter(row=>row.date<=date&&!completed.has(Number(row.lessonId))&&row.kind!=='planned').sort((a,b)=>a.date.localeCompare(b.date))[0];
  if (pending) return {lessonId:Number(pending.lessonId),resume:true};
  for (let id=1;id<=total;id++) if (!completed.has(id)) return {lessonId:id,resume:false};
  return null;
}
