import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {normalizeEnglishPunctuation,spokenEnglish} from '../public/studio/pronunciation.js';
import {createStore} from '../public/studio/study-store.js';

const source=await readFile(new URL('../public/studio/application.js',import.meta.url),'utf8');
function fn(name){
  const match=new RegExp(`(?:^|\\n)((?:async )?function ${name}\\()`).exec(source);
  assert.ok(match,`Missing ${name}`);
  const start=match.index+(source[match.index]==='\n'?1:0),tail=source.slice(start);
  const end=/\n(?:(?:async )?function |const |let |window\.|bootstrap\()/.exec(tail);
  return end?tail.slice(0,end.index):tail;
}
const esc=value=>normalizeEnglishPunctuation(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const line={speaker:'Guest',en:'"Hello," I\'m ready.',zh:'这是唯一的全句中文。',chunks:[{en:'"Hello,"',zh:'不应重复的词组中文'},{en:"I'm ready.",zh:'另一段词组中文'}],annotations:[{quote:'"Hello,"',text:'第一条完整笔记。\n保留换行与整段解释。'},{text:'第二条笔记 <script> 不应成为HTML。'}]};
function render(name,overrides={}){
  return runInNewContext(`${fn('annotationsMarkup')}\n${fn(name)}\n${name}()`,{
    esc,ui:{showEn:true,showZh:true,showTranscript:true,line:0,stage:2},dialogue:()=>({lines:[line]}),
    sentences:()=>[line],sentenceSegment:()=>({}),recordingControls:()=>'',toolbar:()=>'',icon:()=>'',...overrides});
}

test('English apostrophes normalize to ASCII and existing straight quotes stay unchanged',()=>{
  assert.equal(normalizeEnglishPunctuation(`"I'm ready." ‘Hello’ Iʼll use＇ASCII＇.`),`"I'm ready." 'Hello' I'll use'ASCII'.`);
  assert.equal(normalizeEnglishPunctuation(`"I'm ready."`),`"I'm ready."`);
  assert.equal(spokenEnglish('I’m ready. Iʼll go. I＇m here. I‘m fine.'),"I'm ready. I'll go. I'm here. I'm fine.");
});

test('old British preference migrates to US without changing learning records',()=>{
  const saved={accent:'en-GB',startDate:'2026-10-01',progress:{'1:0':[1,2]},history:[],dialogueCompletions:{}};
  const migrated=createStore(saved);assert.equal(migrated.accent,'en-US');assert.deepEqual(migrated.progress,saved.progress);
  assert.equal(migrated.startDate,saved.startDate);assert.equal(createStore().accent,'en-US');assert.equal(saved.accent,'en-GB');
});
test('transcript retains clickable English, one full translation and both complete annotations',()=>{
  const html=render('transcript');
  assert.ok(html.includes('data-chunk="0:0"')&&html.includes('data-chunk="0:1"'));
  assert.ok(!html.includes('词组中文'));assert.equal(html.split(line.zh).length-1,1);
  assert.ok(html.includes('第一条完整笔记。\n保留换行与整段解释。'));
  assert.ok(html.includes('第二条笔记 &lt;script&gt; 不应成为HTML。'));
  assert.equal((html.match(/class="sentence-note"/g)||[]).length,2);
  assert.ok(html.includes('&quot;Hello,&quot;')&&html.includes('I&#39;m ready.'));
  assert.ok(!html.includes('这句话下面标注'));
  assert.doesNotMatch(html, /<blockquote|note-quote/);
  assert.equal(html.split('&quot;Hello,&quot;').length-1,1,'English phrase occurs only in the original');
});
test('actual transcript output contains ASCII apostrophe entities and no curly apostrophes',()=>{
  const variant={...line,en:'I’m ready. Iʼll go.',chunks:[{en:'I’m ready. Iʼll go.'}],annotations:[{quote:'I＇m ready.',text:'I‘m 保留原有意思。'}]};
  const html=render('transcript',{dialogue:()=>({lines:[variant]})});
  assert.ok(html.includes('I&#39;m ready. I&#39;ll go.'));assert.ok(html.includes('I&#39;m 保留原有意思。'));
  assert.ok(!/[‘’ʼ＇]/.test(html));
});
test('hiding Chinese also hides every annotation while preserving English playback buttons',()=>{
  const html=render('transcript',{ui:{showEn:true,showZh:false}});
  assert.ok(!html.includes(line.zh));assert.ok(!html.includes('sentence-note'));assert.ok(!html.includes('第一条完整笔记'));
  assert.ok(html.includes('data-chunk="0:0"'));
});
test('sentence comparison shows its own notes after the full Chinese translation',()=>{
  for(const stage of [2,7,8]){
    const html=render('sentenceUI',{ui:{showTranscript:true,showZh:true,line:0,stage}});
    assert.equal(html.split(line.zh).length-1,1);assert.equal((html.match(/class="sentence-note"/g)||[]).length,2);
    assert.ok(html.indexOf('sentence-note')>html.indexOf(line.zh));
    assert.doesNotMatch(html, /<blockquote|note-quote/);
  }
  assert.ok(!render('sentenceUI',{ui:{showTranscript:true,showZh:false,line:0,stage:2}}).includes('sentence-note'));
  assert.ok(!render('sentenceUI',{ui:{showTranscript:false,showZh:true,line:0,stage:8}}).includes('sentence-note'));
});
test('scenario navigation and weekend/completed-course entry points are absent',()=>{
  const nav=runInNewContext(`${fn('navigation')}\nnavigation()`,{ui:{page:'home'},icon:()=>''});
  assert.ok(!nav.includes('practice')&&!nav.includes('情景'));
  for(const weekend of [true,false]){
    const tasks=runInNewContext(`${fn('dailyTaskPanel')}\ndailyTaskPanel()`,{isWeekend:()=>weekend,today:'2026-10-20',dailyLesson:()=>null,store:{},curriculum:{lessons:[]}});
    assert.ok(!tasks.includes('practice')&&!tasks.includes('情景'));assert.ok(tasks.includes('reviews'));
  }
});
test('legacy practice route and stale chat action cannot enter or invoke scenario functionality',async()=>{
  const page=runInNewContext(`${fn('pageContent')}\npageContent()`,{ui:{page:'practice'},homePage:()=>'home',catalogPage(){},reviewsPage(){},calendarPage(){},planPage(){}});
  assert.equal(page,'home');
  let invoked=false;await runInNewContext(`${fn('action')}\naction('chat-start')`,{SCENARIO_PRACTICE_ENABLED:false,chat:{startConversation(){invoked=true}}});
  assert.equal(invoked,false);
  const old={dataset:{page:'practice'}},ui={page:'home'};
  runInNewContext(`${fn('bind')}\nbind()`,{document:{querySelectorAll:selector=>selector==='[data-page]'?[old]:[]},$:()=>null,VISIBLE_PAGES:new Set(['home','reviews']),ui,stopMedia(){invoked=true}});
  old.onclick();assert.equal(ui.page,'home');assert.equal(invoked,false);
});
test('pronunciation ignores a stale British argument and always requests US audio',async()=>{
  let requested;const store={accent:'en-GB'};
  await runInNewContext(`${fn('pronounce')}\npronounce("I'm ready.",'en-GB')`,{store,stopMedia(){},persist(){},spokenEnglish,ttsRequest:0,ttsAudio:null,ttsReady:null,chatState:{configured:true},chat:{tts:async(text,accent)=>{requested={text,accent};return{audioUrl:'fixture',accent:'en-US'}}},Audio:class{async play(){}},toast:message=>{throw Error(message)}});
  assert.equal(requested.accent,'en-US');assert.equal(store.accent,'en-US');
});
test('pronunciation popup no longer contains chunk Chinese or a British button',()=>{
  const popup=fn('openPronunciation');assert.ok(!popup.includes('chunk.zh'));assert.ok(!popup.includes('pronounce-gb'));assert.ok(!popup.includes('en-GB'));
});
