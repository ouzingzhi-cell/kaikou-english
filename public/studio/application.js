import {toDateKey,isWeekend,getReviewBuckets,buildStudyPlan} from './scheduler.js';
import {createStore,clearLearningRecords,completeDialogue,getDialogueCompletion,reviewHistory,reviewDialogueIndices,isReviewed,markReviewed,weeklyReviews,learnedIds,overdueReviews,dailyLesson} from './study-store.js';
import {getCheckinEligibility,getMonthGrid} from './checkin.js';
import {SegmentPlayer,RecordingBank} from './audio-engine.js';
import {spokenEnglish,normalizeEnglishPunctuation} from './pronunciation.js';
import {MobileVoiceChat, MOBILE_VOICES} from './mobile-voice-chat.js';
import {transferScenarios} from './scenarios.js';
import {getPracticeUnits} from './practice-units.js';

const $=selector=>document.querySelector(selector);
const SCENARIO_PRACTICE_ENABLED=false;
const VISIBLE_PAGES=new Set(['home','catalog','reviews','calendar','plan']);
const esc=value=>normalizeEnglishPunctuation(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons={home:'<path d="m3 10 9-7 9 7v11h-6v-7H9v7H3Z"/>',book:'<path d="M12 5v16M3 3c4-1 6 0 9 2 3-2 5-3 9-2v16c-4-1-6 0-9 2-3-2-5-3-9-2Z"/>',review:'<path d="M3 10a9 9 0 1 1 1 8M3 4v6h6M12 7v5l3 2"/>',chat:'<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 0 1-1-5 8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/>',calendar:'<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M7 2v4M17 2v4M3 10h18M8 14h2M14 14h2M8 18h2"/>',settings:'<path d="m9 3-1 3-3 1-2 3 2 3v4l4 1 3 3 3-3 4-1v-4l2-3-2-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',chevron:'<path d="m9 6 6 6-6 6"/>',play:'<path d="m8 4 12 8-12 8Z" fill="currentColor" stroke="none"/>',pause:'<path d="M8 5v14M16 5v14" stroke-width="3"/>',stop:'<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>',volume:'<path d="m11 4-6 5H2v6h3l6 5ZM15 8a5 5 0 0 1 0 8M18 5a9 9 0 0 1 0 14"/>',mic:'<rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',flag:'<path d="M5 22V3c5-4 9 4 15 0v11c-6 4-10-4-15 0"/>',check:'<path d="m5 12 4 4L19 6"/>',leaf:'<path d="M6 20C-2 9 9 1 22 3c1 11-6 21-16 17ZM6 20l11-12M10 16l-1-5m5 1h4"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>'};
const icon=(name,style='')=>`<svg viewBox="0 0 24 24" aria-hidden="true" style="${style}">${icons[name]||icons.book}</svg>`;
const time=value=>`${Math.floor((value||0)/60).toString().padStart(2,'0')}:${Math.floor((value||0)%60).toString().padStart(2,'0')}`;
const dateText=(date,opts={month:'numeric',day:'numeric',weekday:'short'})=>new Intl.DateTimeFormat('zh-CN',opts).format(new Date(`${date}T12:00:00`));
let today=toDateKey(new Date()),saved={};
try{saved=JSON.parse(localStorage.getItem('kaikou-ipad-v1')||'{}')}catch{}
const store=createStore(saved);store.startDate ||= today;
const ui={page:'home',dialogue:0,stage:0,line:0,showEn:true,showZh:true,showTranscript:false,speed:1,review:null,
  reviewDate:today,month:today.slice(0,7),chatScenario:'',chatModes:{},popover:null};
let lastReplyId=null;
let curriculum,manifest,ambiences=[],playerState={status:'idle',position:0,duration:0},recordState={status:'idle'},chatState={status:'idle',messages:[],configured:false},toastTimer,ttsAudio=null,ttsReady=null,ttsRequest=0,ambienceAudio=null;
const stages=['常速热身','精读理解','听句复述','听力加速','听力减速','噪音训练','影子跟读','听音复习','中译英'];
const stageTitles=['完整听一遍正文','读懂每一句，也读懂每个词组','听一句原音，再录下你的复述','逐级加速，听清这段对话','从快到慢，抓住每个细节','在人声嘈杂的环境里听懂','跟随原音，同步开口','再听原音，逐句复述','看中文，用英语说出来'];
const stageHints=['只播放当前对话的一遍常速正文。','点击英文词组，收听美音朗读。','听完这一句会自动停下，再录音并回听。','点击一个速度，只播放当前对话一遍。','点击一个速度，只播放当前对话一遍。','原音保持 1×，背景为多人交谈的环境实录。','原音保持 1×，跟读录音可暂停、停止回放。','听完这一句会自动停下，再录音并对照原文。','先看中文并录音，再对照原文。'];

function toast(message){$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),4000)}
function persist(next=store){try{localStorage.setItem('kaikou-ipad-v1',JSON.stringify(next));if(next!==store)Object.assign(store,next);return true}catch{toast('本机未能保存记录，请导出学习记录后重试。');return false}}
function lesson(){return curriculum.lessons.find(item=>Number(item.id)===Number(store.selectedLesson))||curriculum.lessons[0]}
function dialogue(){return lesson().dialogues[ui.dialogue]}
const practiceUnitCache=new Map();
function sentences(){const d=dialogue();if(!practiceUnitCache.has(d.id))practiceUnitCache.set(d.id,getPracticeUnits(d,curriculum.sentencePractice?.[d.id]||[],audioInfo()));return practiceUnitCache.get(d.id)}
function audioInfo(){return manifest.dialogues?.[dialogue().id]}
function ownsPlayback(){return playerState.id===dialogue()?.id||Boolean(playerState.id?.startsWith(dialogue()?.id+':sentence:'))}
function recordingKey(){return `${dialogue().id}:${ui.stage}:${ui.line}`}
function dialogueFinished(index=ui.dialogue){return ui.review?isReviewed(store,ui.review.dueDate,lesson().id,ui.review.offset,index):Boolean(getDialogueCompletion(store,lesson().id,index))}
function visibleDialogues(){const indices=ui.review?reviewDialogueIndices(store,lesson().id,ui.review.dueDate,ui.review.offset):lesson().dialogues.map((_,index)=>index);return lesson().dialogues.map((item,index)=>({item,index})).filter(({index})=>indices.includes(index))}
function isFullReady(info=audioInfo()){return Boolean(info?.status==='ready'&&info?.url&&Number.isFinite(info.duration)&&info.duration>0)}
function sentenceSegment(index=ui.line){const info=audioInfo(),span=sentences()[index]?.audio;return isFullReady(info)&&span?.status==='ready'&&Number.isFinite(span.start)&&Number.isFinite(span.end)&&span.end>span.start?{url:info.url,start:span.start,end:span.end,speed:1,id:`${dialogue().id}:sentence:${index}`} : null}
function sourceVariationNote(){
  const info=audioInfo(),notes=[2,7,8].includes(ui.stage)?[sentences()[ui.line]?.note]:(info?.sourceVariations||[]).map(item=>item.note);
  return [...new Set(notes.filter(Boolean))].map(note=>`<p class="source-variation">${esc(note)}</p>`).join('');
}

const player=new SegmentPlayer({onChange:snapshot=>{playerState=snapshot;syncPlayer();syncAmbience()},onError:toast});
const recordings=new RecordingBank({onChange:snapshot=>{recordState=snapshot;if(curriculum)syncRecording()},onError:message=>toast(message.includes('localhost')?'请在 Safari 通过 HTTPS 打开此页面，并允许麦克风。':message)});
const chat=new MobileVoiceChat({onChange:snapshot=>{chatState=snapshot;if(SCENARIO_PRACTICE_ENABLED&&curriculum&&ui.page==='practice'){renderChat();const last=snapshot.messages.filter(item=>item.role==='assistant').at(-1);if(last?.audioUrl&&last.id!==lastReplyId&&snapshot.status==='idle'){lastReplyId=last.id;queueMicrotask(()=>{if(!document.hidden)toast('AI 语音已准备好，点击语音气泡播放。')})}}},onError:error=>toast(error.message),getContext:()=>({
  scenario:ui.chatScenario||`练习 ${lesson().title}。你扮演这个主题中与学习者对话的人物，每次说1至2句自然英语，等待用户语音回复。`,
  learnedContext:curriculum.lessons.map(item=>({...item,dialogues:item.dialogues.filter((d,index)=>item.id===lesson().id||Boolean(getDialogueCompletion(store,item.id,index)))})).filter(item=>item.dialogues.length).sort((a,b)=>Number(b.id===lesson().id)-Number(a.id===lesson().id)).map(item=>`${item.title}: ${item.dialogues.map(d=>d.lines.map(l=>l.en).join(' ')).join('\n')}`).join('\n').slice(0,22000),accent:'en-US'
})});

function stopTts(){++ttsRequest;window.speechSynthesis?.cancel();if(ttsAudio){ttsAudio.pause();ttsAudio=null}ttsReady=null}
function stopMedia({keepRecording=false}={}){player.stop();recordings.stopReplay();chat.stopPlayback();stopTts();stopAmbience();if(!keepRecording)recordings.stop()}
function stopAmbience(){if(ambienceAudio)ambienceAudio.pause()}
function syncAmbience(){
  if(ui.stage!==5||playerState.status!=='playing'){stopAmbience();return}
  const item=ambiences.find(item=>item.id===store.noiseScene)||ambiences[0];if(!item)return;
  const url=new URL(item.url,location.href).href;
  if(!ambienceAudio||ambienceAudio.src!==url){stopAmbience();ambienceAudio=new Audio(url);ambienceAudio.loop=true}
  ambienceAudio.volume=store.noiseVolume/100;
  if(ambienceAudio.paused)ambienceAudio.play().catch(()=>toast('环境声未能加载，请检查音频资源。'));
}

async function playFull(speed=ui.speed){
  if(recordState.status==='recording'&&ui.stage!==6){toast('请先结束录音，再播放原音。');return}
  if(!isFullReady()){toast('这段录音正在对齐，暂时不能播放。');return}
  const info=audioInfo();recordings.stopReplay();chat.stopPlayback();stopTts();
  ui.speed=[0,5,6].includes(ui.stage)?1:speed;
  await player.play({url:info.url,start:0,end:info.duration,speed:ui.speed,id:dialogue().id});syncPlayer();
}
async function playSentence(){if(recordState.status==='recording'){toast('请先结束录音，再播放原音。');return}const span=sentenceSegment();if(!span){toast('这一句原音尚未完成对齐，不能用合成音替代。');return}recordings.stopReplay();stopTts();await player.play(span)}
async function pronounce(text){
  const accent='en-US';
  const spoken=spokenEnglish(text);
  if(ttsAudio&&ttsReady?.text===spoken&&ttsReady.accent===accent){try{ttsAudio.currentTime=0;await ttsAudio.play()}catch{toast('发音已准备好，请再次点击美音播放。')}return}
  stopMedia();store.accent=accent;persist();const request=++ttsRequest;
  try{
    if(chatState.configured){const result=await chat.tts(spoken,accent);if(request!==ttsRequest)return;if(result.fallback&&result.accent!==accent){toast('美音朗读暂不可用，请稍后重试。');return}ttsAudio=new Audio(result.audioUrl);ttsReady={text:spoken,accent};await ttsAudio.play();return}
    if(!window.speechSynthesis)throw new Error('当前设备没有英语朗读服务，请连接智能语音。');
    const voices=speechSynthesis.getVoices(),voice=voices.find(item=>item.lang.toLowerCase()===accent.toLowerCase());
    if(!voice){toast('系统未安装美音语音，请连接美音朗读服务。');return}
    const utterance=new SpeechSynthesisUtterance(spoken);utterance.voice=voice;utterance.lang=accent;utterance.rate=.9;speechSynthesis.speak(utterance);
  }catch(error){toast(error.name==='NotAllowedError'&&ttsReady?'发音已准备好，再点击一次美音播放。':error.message||'朗读暂不可用。')}
}

function heading(title,subtitle){return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div><span class="date-pill">${icon('calendar','width:13px;height:13px;margin-right:7px')}${dateText(today)}</span></div>`}
function homeHeading(){
  const current=lesson(),completed=current.dialogues.filter((d,index)=>getDialogueCompletion(store,current.id,index)).length,total=current.dialogues.length;
  return `<div class="page-heading home-heading"><div class="home-title"><h1>第 ${String(current.id).padStart(2,'0')} 课 · ${esc(current.title)}</h1><p>${ui.review?'复习模式 · 本次 '+visibleDialogues().length+' 段对话':'5 段对话 · 九阶段训练'}${isWeekend(today)?' · 今天只复习，不安排新课':''}</p></div><section class="course-progress" aria-label="课程进度"><div class="course-progress-title"><strong>课程进度</strong><span>本课 <b>${completed}</b> / ${total} 对话</span><small>已完成 ${learnedIds(store,today).length} / 20 课</small></div><div class="course-progress-track" role="progressbar" aria-label="本课对话完成进度" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${completed}"><span style="width:${completed/total*100}%"></span></div><div class="course-progress-task">${dailyTaskPanel()}</div></section></div>`;
}
function navigation(){const items=[['home','home','今日学习'],['catalog','book','课程目录'],['reviews','review','间隔复习'],['calendar','calendar','打卡日历'],['plan','book','学习方案']];return `<nav class="nav" aria-label="主导航">${items.map(([id,ic,title])=>`<button data-page="${id}" class="${ui.page===id?'active':''}">${icon(ic)}<span>${title}</span></button>`).join('')}</nav>`}
function render(){
  if(!curriculum)return;
  if(!VISIBLE_PAGES.has(ui.page))ui.page='home';
  $('#app').innerHTML=`<div class="shell"><aside class="sidebar"><div class="brand"><div class="brand-mark">${icon('leaf')}</div><div><div class="brand-name">开口</div><small>DAILY ENGLISH</small></div></div>${navigation()}</aside><main class="main"><header class="topbar ${ui.page==='home'?'home-topbar':''}"><div class="top-tools"><button class="checkin-button ${store.checkins[today]?'checked':''}" data-action="checkin">${icon('flag')}${store.checkins[today]?'今日已打卡':'今日打卡'}</button><button class="icon-btn" data-action="settings" aria-label="学习设置">${icon('settings')}</button></div></header><div class="page page-${ui.page}">${pageContent()}</div>${ui.page==='home'?`<div class="player-dock" aria-label="正文播放器">${playerUI()}</div>`:''}</main></div>`;
  bind();syncPlayer();syncRecording();if(SCENARIO_PRACTICE_ENABLED&&ui.page==='practice')renderChat();
}
function pageContent(){return ({home:homePage,catalog:catalogPage,reviews:reviewsPage,calendar:calendarPage,plan:planPage}[ui.page]||homePage)()}

function homePage(){
  const info=audioInfo(),visible=visibleDialogues(),finished=dialogueFinished();
  return `${homeHeading()}<div class="workspace"><div class="content"><div class="dialogue-tabs" role="tablist" aria-label="选择对话">${visible.map(({item:d,index})=>{const completion=getDialogueCompletion(store,lesson().id,index),done=dialogueFinished(index);return `<button role="tab" aria-selected="${ui.dialogue===index}" data-dialogue="${index}" class="dialogue-tab ${ui.dialogue===index?'active':''} ${done?'dialogue-complete':''}" title="${esc(completion?'首次完成：'+completion.date:'尚未标记完成')}"><small>对话 ${index+1}${done?' · ✓':''}</small><strong>${esc(d.title)}</strong></button>`}).join('')}</div><section class="practice-box"><div class="stage-strip" aria-label="九阶段练习">${stages.map((title,index)=>`<button data-stage="${index}" class="stage ${ui.stage===index?'active':''}" aria-current="${ui.stage===index?'step':'false'}"><b>${index+1}</b>${title}</button>`).join('')}</div><div class="stage-head"><div><h3>${stageTitles[ui.stage]}</h3>${![2,7,8].includes(ui.stage)?`<p>${stageHints[ui.stage]}</p>`:''}</div></div><div class="stage-body ${ui.showTranscript?'show-transcript':''}">${stageBody()}${sourceVariationNote()}</div><div class="practice-footer"><div class="stage-navigation"><button class="secondary" data-action="previous-stage" ${ui.stage===0?'disabled':''}>上个阶段</button><button class="secondary" data-action="next-stage" ${ui.stage===8?'disabled':''}>下个阶段</button></div><button class="primary" data-action="complete-dialogue" ${finished?'disabled':''}>${finished?(ui.review?'本对话已复习':'本对话已完成'):(ui.review?'完成本对话复习':'完成本对话')} ${icon(finished?'check':'arrow')}</button></div></section>${!isFullReady(info)?'<p class="help-note">原音处理中：未对齐前不使用机器音代替逐句原音。</p>':''}</div><aside class="right-column">${miniCalendar()}${reviewPanel()}</aside></div>`;
}
function dailyTaskPanel(){
  if(isWeekend(today))return '<p class="help-note">今天只安排间隔复习。</p><button class="secondary" data-page="reviews">开始复习</button>';
  const task=dailyLesson(store,today),topic=curriculum.lessons.find(item=>item.id===Number(task?.lessonId));
  if(task?.completed)return `<p class="help-note">今日新课已完成：第 ${task.lessonId} 课 · ${esc(topic?.title||'')}</p><button class="secondary" data-page="reviews">开始复习</button>`;
  return task?`<p class="help-note">${task.resume?'优先补完':'今日新课'}：第 ${task.lessonId} 课 · ${esc(topic?.title||'')}</p><button class="secondary" data-course="${task.lessonId}">${task.resume?'继续学习':'开始学习'} ${icon('arrow')}</button>`:'<p class="help-note">新课已全部完成，继续巩固与复习。</p><button class="secondary" data-page="reviews">开始复习</button>';
}
function toolbar(){return `<div class="text-toolbar"><span>点击英文词组，收听美音</span><div class="toggle-group"><button class="toggle ${ui.showEn?'on':''}" data-action="toggle-en">${ui.showEn?'✓':'＋'} 英文</button><button class="toggle ${ui.showZh?'on':''}" data-action="toggle-zh">${ui.showZh?'✓':'＋'} 中文</button></div></div>`}
function annotationsMarkup(line){
  if(!ui.showZh||!Array.isArray(line?.annotations))return '';
  return line.annotations.filter(note=>typeof note?.text==='string'&&note.text.trim()).map(note=>`<aside class="sentence-note">${note.quote?`<blockquote class="note-quote">${esc(note.quote)}</blockquote>`:''}<p class="note-text">${esc(note.text)}</p></aside>`).join('');
}
function transcript(){return `${toolbar()}<div class="transcript">${dialogue().lines.map((line,index)=>`<div class="speech-row"><div class="speaker-avatar">${esc(line.speaker.slice(0,1))}</div><div class="line-body"><div class="line-speaker">${esc(line.speaker)} <button data-turn-audio="${index}" aria-label="播放第 ${index+1} 轮原音">${icon('volume')}</button></div>${ui.showEn?`<div class="chunks">${(line.chunks?.length?line.chunks:[{en:line.en}]).map((chunk,j)=>`<button class="chunk" data-chunk="${index}:${j}"><span class="en">${esc(chunk.en)}</span></button>`).join('')}</div>`:''}${ui.showZh?`<p class="sentence-zh">${esc(line.zh||'')}</p>${annotationsMarkup(line)}`:''}${!ui.showEn&&!ui.showZh?`<button class="secondary" data-turn-audio="${index}">${icon('volume')} 播放原音</button>`:''}</div></div>`).join('')}</div>`}
function wave(){return `<div class="audio-art ${playerState.status==='playing'?'playing':''}">${[15,25,39,28,45,23,13].map(height=>`<i style="height:${height}px"></i>`).join('')}</div>`}
function stageBody(){
  if(ui.stage===1)return transcript();
  if([2,7,8].includes(ui.stage))return sentenceUI();
  const speeds=ui.stage===3?[1,1.5,2,3]:ui.stage===4?[3,2,1.5,1]:[1];
  return `<div class="listen-hero">${wave()}<h4>${esc(dialogue().title)}</h4><p>正文原音 · ${time(audioInfo()?.duration)} · 单遍播放</p><div class="speed-ladder">${speeds.map(speed=>`<button data-speed="${speed}" class="${ui.speed===speed?'active':''}">${icon('play','width:12px;height:12px;margin-right:5px')}${speed}×</button>`).join('')}</div>${ui.stage===5?`<div class="ambience-controls"><label for="noise-scene">环境人声</label><select id="noise-scene" class="field">${ambiences.map(item=>`<option value="${item.id}" ${item.id===store.noiseScene?'selected':''}>${esc(item.title)}</option>`).join('')}</select><label for="noise-level">音量 <span id="noise-value">${store.noiseVolume}%</span></label><input id="noise-level" type="range" min="0" max="70" value="${store.noiseVolume}"></div>`:''}${ui.stage===6?`<div class="recorder-actions" style="justify-content:center">${recordingControls(true)}</div>`:''}<button class="muted-link" data-action="toggle-transcript">${ui.showTranscript?'收起文本':'打开对话文本'}</button></div>${ui.showTranscript?transcript():''}`;
}
function sentenceUI(){const list=sentences(),line=list[ui.line];if(!line)return '<div class="notice">这段文本正在整理。</div>';return `<div class="recorder"><div class="sentence-nav large-nav"><button class="sentence-step" data-action="previous-line" ${ui.line===0?'disabled':''}>${icon('chevron','transform:rotate(180deg)')} 上一句</button><span><strong>第 ${ui.line+1} / ${list.length} 句</strong><small>${esc(line.speaker)}</small></span><button class="sentence-step" data-action="next-line" ${ui.line===list.length-1?'disabled':''}>下一句 ${icon('chevron')}</button></div><div class="prompt-card">${ui.stage===8?`<p class="prompt-zh">${esc(line.zh||'')}</p>`:`<button class="listen-sentence" data-action="listen-sentence" ${sentenceSegment()?'':'disabled'}>${icon('volume')} 听这一句</button>`}${ui.showTranscript?`<p class="prompt-en">${esc(line.en)}</p>${ui.stage!==8&&ui.showZh?`<p class="prompt-zh">${esc(line.zh||'')}</p>`:''}${annotationsMarkup(line)}`:''}</div><div class="recorder-actions">${recordingControls()}<button class="secondary" data-action="toggle-transcript">${ui.showTranscript?'隐藏原文':'对照原文'}</button></div></div>`}
function recordingControls(shadow=false){const key=recordingKey(),recording=recordState.status==='recording'&&recordState.key===key,replaying=recordState.replayKey===key&&recordState.replayStatus==='playing';return `<button class="record-button ${recording?'recording':''}" data-action="record" ${recordState.status==='requesting'?'disabled':''}>${icon('mic')}${recording?'结束录音':recordState.status==='requesting'?'正在请求麦克风…':shadow?'录下跟读':'录下我的英文'}</button><button class="secondary" data-action="replay" ${recordings.has(key)?'':'disabled'}>${icon(replaying?'stop':'play')}<span>${replaying?'停止回听':'回听录音'}</span></button>${shadow?`<button class="secondary" data-action="pause-replay" ${replaying?'':'disabled'}>${icon('pause')}暂停回放</button><button class="secondary" data-action="stop-replay" ${recordState.replayKey?'':'disabled'}>${icon('stop')}停止回放</button>`:''}`}
function playerUI(){return `<div class="player"><button class="play-big" data-action="toggle-player" aria-label="播放当前正文">${icon(playerState.status==='playing'?'pause':'play')}</button><div class="player-track"><div class="player-title"><span>${esc(dialogue().title)} · ${ui.speed}×</span><small id="player-kind">正文单遍原音</small></div><input id="audio-seek" type="range" min="0" max="${audioInfo()?.duration||1}" value="0" step=".01" aria-label="当前正文播放进度"></div><span id="player-time" class="player-time">00:00 / ${time(audioInfo()?.duration)}</span><button class="icon-btn player-stop" data-action="stop-player" aria-label="停止播放并归零" title="停止播放，进度归零">${icon('stop')}<span>停止</span></button></div>`}
function miniCalendar(){const rows=getMonthGrid(ui.month,store.checkins,today).filter(row=>row.inMonth);return `<section class="panel calendar-panel"><div class="panel-head"><h3>${ui.month.replace('-',' 年 ')} 月</h3><button class="muted-link" data-page="calendar">打卡日历 →</button></div><div class="month-weekdays">${['一','二','三','四','五','六','日'].map(day=>`<span>${day}</span>`).join('')}</div><div class="month-grid compact">${Array.from({length:(new Date(`${ui.month}-01T12:00:00`).getDay()+6)%7},()=>'<span></span>').join('')}${rows.map(row=>`<button data-calendar-date="${row.date}" class="calendar-day ${row.isToday?'today':''} ${row.checked?'checked':''}"><span>${row.day}</span>${row.checked?icon('flag'):''}</button>`).join('')}</div><button class="primary checkin-wide" data-action="checkin">${icon('flag')}${store.checkins[today]?'今日已插旗':'完成后，给今天插一面旗'}</button></section>`}
function reviewPanel(){return `<section class="panel"><div class="panel-head"><h3>今天的间隔复习</h3><span>0 · 1 · 3 · 7</span></div>${getReviewBuckets(today,reviewHistory(store)).map(bucket=>`<button class="review-card" data-page="reviews" style="width:100%;text-align:left"><span class="offset">-${bucket.offset}</span><span class="details"><h4>${bucket.date.slice(5).replace('-',' / ')}</h4><small>${bucket.items.length?bucket.items.map(h=>`第 ${h.lessonId} 课·对话 ${h.dialogueIndex+1}`).join('、'):'这一天没有学习记录'}</small></span>${icon('chevron')}</button>`).join('')}</section>`}
function catalogPage(){return `${heading('课程目录','20 个主题 · 100 篇文本与原录音')}<div class="catalog">${curriculum.lessons.map(item=>{const ready=item.dialogues.filter(d=>isFullReady(manifest.dialogues[d.id])).length,completed=learnedIds(store,today).includes(item.id),count=item.dialogues.filter((d,index)=>getDialogueCompletion(store,item.id,index)).length;return `<button class="course-card available ${item.id===lesson().id?'selected':''}" data-course="${item.id}"><small>LESSON ${String(item.id).padStart(2,'0')} ${completed?'· ✓ 已完成':count?'· 已完成 '+count+'/5':''}</small><h3>${esc(item.title)}</h3><p>5 段对话 · ${ready}/5 原音就绪</p></button>`}).join('')}</div>`}
function reviewsPage(){const buckets=getReviewBuckets(ui.reviewDate,reviewHistory(store)),random=weeklyReviews(store,ui.reviewDate,today),backlog=overdueReviews(store,ui.reviewDate);persist();return `${heading('间隔复习','按每段对话的完成日期安排 0、1、3、7 天复习')}<div class="date-control"><label for="review-date">查看日期</label><input id="review-date" type="date" value="${ui.reviewDate}"><button class="secondary" data-action="review-today">回到今天</button><span>${isWeekend(ui.reviewDate)?'周末 · 只复习':'工作日 · 新课 + 复习'}</span></div><div class="wide-layout"><div><div class="review-grid">${buckets.map(bucket=>`<section class="review-large"><div class="offset">-${bucket.offset}</div><h3>${bucket.offset?'巩固之前学过的内容':'当天内容巩固'}</h3><p>${dateText(bucket.date,{month:'long',day:'numeric',weekday:'long'})} · ${bucket.date}</p>${bucket.items.length?bucket.items.map(record=>reviewRow(record,ui.reviewDate,bucket.offset)).join(''):'<p class="empty-line">这一天没有学习记录。</p>'}</section>`).join('')}</div>${backlog.length?`<section class="plan-doc" style="margin-top:20px"><h3>待补复习 · ${backlog.length} 项</h3>${backlog.map(record=>reviewRow(record,record.dueDate,record.offset)).join('')}</section>`:''}</div><aside><section class="panel"><h3>每周随机复习</h3>${random.length?random.map(record=>reviewRow(record,ui.reviewDate,'weekly')).join(''):`<p class="help-note">完整完成第 11 个主题课后，每周固定抽取两课。当前完成 ${learnedIds(store,ui.reviewDate).length} 课。</p>`}</section></aside></div>`}
function reviewRow(record,date,offset){
  const index=Number.isInteger(record.dialogueIndex)?record.dialogueIndex:undefined,done=isReviewed(store,date,record.lessonId,offset,index),topic=curriculum.lessons.find(item=>item.id===Number(record.lessonId)),title=index===undefined?topic?.title:topic?.dialogues[index]?.title;
  const label=`第 ${record.lessonId} 课${index===undefined?'':' · 对话 '+(index+1)} · ${title||record.title||''}`,payload=`${record.lessonId}|${date}|${offset}|${index??''}`;
  return `<div class="review-item"><span>${esc(label)}${done?' · ✓':''}</span><button class="secondary" data-review="${payload}">${done?'再次复习':'去复习'}</button><button class="muted-link" data-review-done="${payload}">${done?'已完成':'标记完成'}</button></div>`;
}
function calendarPage(){const rows=getMonthGrid(ui.month,store.checkins,today);return `${heading('学习打卡日历','每天自行确认完成情况，为坚持学习插一面小旗。')}<section class="calendar-full"><div class="calendar-title"><button class="secondary" data-action="previous-month">${icon('chevron','transform:rotate(180deg)')}上个月</button><h2>${ui.month.replace('-',' 年 ')} 月</h2><button class="secondary" data-action="next-month">下个月${icon('chevron')}</button></div><div class="month-weekdays">${['周一','周二','周三','周四','周五','周六','周日'].map(day=>`<span>${day}</span>`).join('')}</div><div class="month-grid full">${rows.map(row=>`<button data-calendar-date="${row.date}" class="calendar-day ${row.inMonth?'':'other-month'} ${row.isToday?'today':''} ${row.checked?'checked':''}" ${row.isFuture?'disabled':''}><span>${row.day}</span>${row.checked?icon('flag'):'<small></small>'}${row.checked?'<small>已打卡</small>':''}</button>`).join('')}</div><div class="calendar-footer"><span>本月已打卡 ${Object.keys(store.checkins).filter(date=>date.startsWith(ui.month)).length} 天</span><button class="primary" data-action="checkin">${icon('flag')}${store.checkins[today]?'查看今日打卡':'今日打卡'}</button></div></section>`}
function practicePage(){return `${heading('情景语音对话','你发一段语音，AI 根据你的回答回复语音；文字按需展开。')}<div class="voice-layout"><aside class="panel"><h3>练习场景</h3><label class="field-label" for="scenario-select">从当前课程选择</label><select id="scenario-select" class="field"><option value="">${esc(lesson().title)} · 自由场景</option><optgroup label="学以致用 · 换个场景">${transferScenarios(lesson().id).map(title=>`<option value="${esc(title)}" ${ui.chatScenario===title?'selected':''}>${esc(title)}</option>`).join('')}</optgroup><optgroup label="教材场景">${lesson().dialogues.map(d=>`<option value="${esc(d.title)}" ${ui.chatScenario===d.title?'selected':''}>${esc(d.title)}</option>`).join('')}</optgroup></select><p class="help-note">AI 会参考当前课程及已经学过的主题，用自然的英语和你互动。</p><div class="api-status"><i class="status-dot"></i>${chatState.configured?`${chatState.config?.provider==='deepseek'?'DeepSeek':'OpenAI'} 已配置`:'尚未配置智能语音 API'}</div><button class="secondary" data-action="settings">智能语音设置</button><div class="panel-footnote">AI 生成语音。情景练习录音通过在线服务发送给 OpenAI 识别。${chatState.config?.provider==='deepseek'?'识别文本发送给 DeepSeek，回复由 OpenAI 朗读。':'对话与朗读也由 OpenAI 处理。'}其他训练录音仅留在当前页面。</div></aside><section class="chat-box voice-chat"><header class="chat-head"><h3>${esc(ui.chatScenario||lesson().title)}</h3><button class="muted-link" data-action="reset-chat">重新开始</button></header><div id="voice-messages" class="chat-messages"></div><div id="voice-controls" class="voice-controls"></div></section></div>`}
function renderChat(){
  const target=$('#voice-messages');if(!target)return;
  const connection=$('.api-status');if(connection)connection.innerHTML=`<i class="status-dot"></i>${chatState.config?.provider==='deepseek'?'DeepSeek':'OpenAI'} ${chatState.configured?'已配置':'需要连接'}`;
  const busy=['thinking','requesting'].includes(chatState.status),recording=chatState.status==='recording';
  target.innerHTML=chatState.messages.length?chatState.messages.map(message=>{
    const mode=ui.chatModes[message.id]||0,playing=chatState.playingId===message.id,needsAudio=message.role==='assistant'&&message.needsAudio;
    const retryDisabled=busy||recording?'disabled':'';
    const errorText=['LOCAL_TTS','AI_TTS'].includes(message.errorCode)?'可直接重试生成语音。':message.errorCode==='AI_RESPONSE'?'模型回复格式异常，可直接重试 AI 回复。':message.errorMessage||'请稍后重试。';
    const retry=needsAudio?`<button data-chat-retry-audio="${esc(message.id)}" ${retryDisabled}>重新生成语音</button>`:message.failed&&(message.retryable||chatState.configured&&['AI_AUTH','CONFIG_REQUIRED'].includes(message.errorCode))?`<button data-chat-retry="${esc(message.id)}" ${retryDisabled}>${message.en?'重试 AI 回复':'重试识别'}</button>`:'';
    return `<div class="voice-message ${message.role==='user'?'user':''} ${message.failed?'failed':''}"><span class="voice-avatar">${message.role==='user'?'我':'AI'}</span><div class="voice-message-body"><button class="voice-bubble ${playing?'playing':''}" ${needsAudio?`data-chat-retry-audio="${esc(message.id)}" ${retryDisabled}`:`data-chat-play="${esc(message.id)}" ${recording||chatState.status==='requesting'?'disabled':''}`}>
      ${icon(needsAudio?'review':playing?'stop':'volume')}<span class="voice-wave">${needsAudio?'语音待生成':'▁ ▃ ▆ ▂ ▅ ▇ ▃ ▁ ▅ ▂'}</span><span>${needsAudio?'点击重试':message.duration?`${Math.max(1,Math.round(message.duration))}″`:'语音'}</span>${message.pending?'<small>发送中…</small>':''}</button><div class="voice-message-actions"><button data-chat-text="${esc(message.id)}">${mode===0?'转英文文本':mode===1?'中英对照':'收起文本'}</button>${retry}</div>${message.failed?`<p class="voice-message-error" role="status">${esc(message.en?(needsAudio?'AI 已回复，语音生成未完成。':'语音已识别，AI 回复未完成。'):'这条语音尚未处理完成。')} ${esc(errorText)}</p>`:''}${mode?`<div class="voice-transcript"><p>${esc(message.en||'转写尚未完成')}</p>${mode===2?`<p class="sentence-zh">${esc(message.zh||'')}</p>`:''}</div>`:''}</div></div>`;
  }).join(''):`<div class="voice-empty">${icon('mic')}<h3>准备好就开口吧</h3><p>可以请 AI 先开场，也可以直接录下你的第一句。</p></div>`;
  $('#voice-controls').innerHTML=`${chatState.playbackHint?`<div class="notice" role="status">${esc(chatState.playbackHint)}</div>`:''}${chatState.error&&!chatState.messages.some(message=>message.failed&&message.errorMessage===chatState.error)?`<div class="notice">${esc(chatState.error)}</div>`:''}<div class="voice-status">${chatState.status==='thinking'?'AI 正在处理这条语音并准备回复…':chatState.status==='requesting'?'正在连接麦克风…':recording?'录音中，点「发送语音」结束并发送':''}</div><div class="voice-buttons"><button class="secondary" data-action="chat-start" ${busy||recording?'disabled':''}>请 AI 先开场</button><button class="primary voice-record ${recording?'recording':''}" data-action="chat-record" ${busy?'disabled':''}>${icon('mic')}${recording?'发送语音':'点击录音'}</button>${recording?'<button class="secondary" data-action="chat-cancel">取消录音</button>':''}<button class="secondary" data-action="chat-stop">${icon('stop')}停止播放</button></div>`;
  target.querySelectorAll('[data-chat-play]').forEach(button=>button.onclick=()=>{player.stop();recordings.stopReplay();chat.togglePlayback(button.dataset.chatPlay)});
  target.querySelectorAll('[data-chat-text]').forEach(button=>button.onclick=()=>{ui.chatModes[button.dataset.chatText]=((ui.chatModes[button.dataset.chatText]||0)+1)%3;renderChat()});
  target.querySelectorAll('[data-chat-retry]').forEach(button=>button.onclick=()=>{stopMedia();chat.retryMessage(button.dataset.chatRetry)});
  target.querySelectorAll('[data-chat-retry-audio]').forEach(button=>button.onclick=()=>{stopMedia();chat.retryAudio(button.dataset.chatRetryAudio)});
  $('#voice-controls').querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>action(button.dataset.action));
  target.scrollTop=target.scrollHeight;
}
function planPage(){const plan=buildStudyPlan(store.startDate);return `${heading('学习方案','每天 1 个主题课，5 段对话；20 个工作日完成新内容。')}<div class="wide-layout"><div><section class="plan-doc"><h3>九阶段训练</h3><ol>${stages.map((title,index)=>`<li><strong>${title}</strong>：${stageHints[index]}</li>`).join('')}</ol><p>九个阶段可自由切换；每段练习完成后，手动点击“完成本对话”。系统记录该段的首次完成日期，五段全部完成才计为一课。</p></section><section class="plan-doc"><h3>新课计划</h3><div class="date-control"><label for="plan-start">开始日期</label><input id="plan-start" type="date" value="${store.startDate}"></div><div class="plan-month">${plan.map(row=>`<div class="plan-cell"><small>${row.date.slice(5)}</small><strong>第 ${row.lessonId} 课</strong></div>`).join('')}</div></section><section class="plan-doc"><h3>复习与打卡</h3><p>复习按每段对话首次标记完成后的 0、1、3、7 个自然日安排，周末不排新课。漏做的复习保留为待补任务；完成第 11 个主题后，每周随机抽两课，周内固定。</p><p>工作日打卡时分别确认新课与复习已经完成；周末只确认复习。打卡记录显示在日历里，和对话完成记录分别保存。</p></section></div><aside><section class="panel"><h3>教材与原音检查</h3><p class="help-note">${curriculum.lessons.length} 个主题，${curriculum.lessons.reduce((n,l)=>n+l.dialogues.length,0)} 篇文本，${curriculum.lessons.reduce((count,l)=>count+l.dialogues.reduce((n,d)=>n+d.lines.length,0),0)} 轮完整发言练习。</p><p class="help-note">原录音只提取一遍正文用于热身、变速、跟读；逐句训练使用原录音时间点，不用机器音替代。</p><a class="muted-link" href="data/content-audit.json" target="_blank">查看内容与发音检查报告 ↗</a><br><a class="muted-link" href="data/audio-audit.json" target="_blank">查看原音对齐报告 ↗</a><br><a class="muted-link" href="assets/ambience/CREDITS.txt" target="_blank">环境声音来源与许可 ↗</a><div class="panel-footnote">中文对照由离线翻译生成并进行结构与重点表达检查，不能等同于逐句人工审校。录音刷新后清除，学习进度保存在本浏览器；可在设置导出备份。</div></section></aside></div>`}

function syncPlayer(){
  const active=playerState.id===dialogue()?.id,selected=playerState.status!=='idle'&&playerState.id?.startsWith(dialogue()?.id+':sentence:');
  const span=selected?sentences()[Number(playerState.id.split(':').at(-1))]?.audio:null;
  const fullDuration=audioInfo()?.duration||0,position=active?playerState.position:span?Math.min(fullDuration,span.start+playerState.position):0;
  const seek=$('#audio-seek');if(seek){seek.max=fullDuration||1;seek.value=position;seek.disabled=!isFullReady()}
  if($('#player-time'))$('#player-time').textContent=`${time(position)} / ${time(fullDuration)}`;
  const button=$('[data-action="toggle-player"]');if(button){const playing=ownsPlayback()&&['playing','loading','resuming'].includes(playerState.status),glyph=playing?'pause':'play';if(button.dataset.glyph!==glyph){button.innerHTML=icon(glyph);button.dataset.glyph=glyph}const label=playing?'暂停播放':ownsPlayback()&&playerState.status==='paused'?'继续播放':'播放当前正文';if(button.getAttribute('aria-label')!==label){button.setAttribute('aria-label',label);button.title=label}}
  const kind=$('#player-kind');if(kind)kind.textContent=selected?`逐句原音 ${time(playerState.position)} / ${time(playerState.duration)}`:'正文单遍原音';
  const listen=$('[data-action="listen-sentence"]');if(listen){const playing=selected&&['playing','loading'].includes(playerState.status),glyph=playing?'stop':'volume';if(listen.dataset.glyph!==glyph){listen.innerHTML=`${icon(glyph)}${playing?'停止这一句':'听这一句'}`;listen.dataset.glyph=glyph}}
  $('.audio-art')?.classList.toggle('playing',active&&playerState.status==='playing');
  document.querySelectorAll('[data-speed]').forEach(button=>button.classList.toggle('active',Number(button.dataset.speed)===ui.speed));
  const title=$('.player-title>span');if(title)title.textContent=`${normalizeEnglishPunctuation(dialogue().title)} · ${ui.speed}×`;
}
function syncRecording(){
  const key=recordingKey(),isRecording=recordState.status==='recording'&&recordState.key===key,replaying=recordState.replayKey===key&&recordState.replayStatus==='playing';
  const button=$('[data-action="record"]');if(button){button.classList.toggle('recording',isRecording);button.disabled=recordState.status==='requesting';button.innerHTML=`${icon('mic')}${isRecording?'结束录音':recordState.status==='requesting'?'正在请求麦克风…':ui.stage===6?'录下跟读':'录下我的英文'}`}
  const replay=$('[data-action="replay"]');if(replay){replay.disabled=!recordings.has(key);replay.innerHTML=`${icon(replaying?'stop':'play')}${replaying?'停止回听':'回听录音'}`}
  const pause=$('[data-action="pause-replay"]');if(pause)pause.disabled=!replaying;
  const stop=$('[data-action="stop-replay"]');if(stop)stop.disabled=!recordState.replayKey;
}

function openCheckin(date=today){
  if(date!==today){const record=store.checkins[date];toast(record?`${date} 已打卡${record.newDone?' · 新课完成':''}${record.reviewDone?' · 复习完成':''}`:date>today?'未来日期不能提前打卡':'这一天没有打卡记录；每天可自行为当天打卡。');return}
  const weekend=isWeekend(today),hasNewLesson=learnedIds(store,today).length<curriculum.lessons.length,existing=store.checkins[today],newDone=existing?.newDone||Boolean(dailyLesson(store,today)?.completed),reviewDone=existing?.reviewDone||false;
  const dialog=$('#settings-dialog');dialog.innerHTML=`<h2>${existing?'今日已打卡':'完成学习了吗？'}</h2><p>${weekend?'今天是周末，只确认复习，不要求新内容。':'确认今天的新内容学习与复习都完成后，即可插旗打卡。'}</p><form id="checkin-form">${weekend?'':`<label class="checkin-question"><input type="checkbox" name="newDone" ${newDone||!hasNewLesson?'checked':''} ${hasNewLesson?'':'disabled'}>完成新内容学习了吗？</label>`}<label class="checkin-question"><input type="checkbox" name="reviewDone" ${reviewDone?'checked':''}>完成复习了吗？</label><div id="checkin-error" role="status"></div><div class="dialog-actions">${existing?'<button type="button" class="muted-link" id="undo-checkin">撤销今日打卡</button>':''}<button type="button" class="secondary" data-close>稍后再来</button><button class="primary" type="submit">${icon('flag')}插旗打卡</button></div></form>`;
  dialog.showModal();dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.querySelector('#undo-checkin')?.addEventListener('click',()=>{delete store.checkins[today];persist();dialog.close();render();toast('今日打卡已撤销，课程进度保留。')});dialog.querySelector('form').onsubmit=event=>{event.preventDefault();const form=new FormData(event.currentTarget),tasks={newDone:!hasNewLesson||form.has('newDone'),reviewDone:form.has('reviewDone')},result=getCheckinEligibility(today,{...tasks,hasNewLesson},today);if(!result.eligible){$('#checkin-error').textContent=result.reason;return}store.checkins[today]={...tasks,checkedAt:new Date().toISOString()};persist();dialog.close();render();toast('打卡成功，今天的小旗已插上。')};
}
function openSettings(){
  const dialog=$('#settings-dialog'),config=chatState.config||{},provider=config.provider==='deepseek'?'deepseek':'openai';
  const initialVoiceConfig={provider,model:provider==='deepseek'?'deepseek-v4-pro':config.model||'gpt-4.1-mini',voice:config.voice||'coral'};
  dialog.innerHTML=`<h2>学习与美音朗读设置</h2><form id="settings-form"><label for="setting-start">学习开始日期</label><input class="field" id="setting-start" type="date" value="${store.startDate}"><p class="help-note">英文词组统一使用美音朗读。</p><section class="learning-records"><h3>学习记录</h3><p>学习进度只保存在此 iPad 版，可导出备份。</p><div class="record-tools"><button type="button" class="secondary" id="export-progress">导出学习记录</button><button type="button" class="danger-button" id="clear-learning-records">清除学习记录</button></div></section><hr><h3>在线美音朗读</h3><p class="help-note">iPad 可独立使用，无需电脑。API Key 仅保留在此页面内存，刷新或关闭页面后需重新填写；不会写入学习记录或离线缓存。在线美音朗读会按服务商计费。</p><div class="service-connection"><span id="online-service-status" role="status">正在检查在线连接…</span><button type="button" class="secondary" id="check-online-service">检查连接</button></div><label for="api-provider">朗读服务账户</label><select class="field" id="api-provider"><option value="openai" ${provider==='openai'?'selected':''}>OpenAI · 美音朗读</option><option value="deepseek" ${provider==='deepseek'?'selected':''}>DeepSeek 账户 + OpenAI 朗读</option></select><p>${chatState.configured?'本页已配置，留空可继续使用当前服务的 Key。':'请填写所选服务的 API Key。'}</p><label id="api-key-label" for="api-key">${provider==='deepseek'?'DeepSeek':'OpenAI'} API Key</label><input class="field" id="api-key" type="password" autocomplete="off" autocapitalize="none" placeholder="sk-…" spellcheck="false"><div id="speech-key-fields" ${provider==='deepseek'?'':'hidden'}><label for="speech-key">OpenAI 语音 API Key</label><input class="field" id="speech-key" type="password" autocomplete="off" autocapitalize="none" placeholder="用于美音朗读" spellcheck="false"><p>美音朗读由 OpenAI 提供，需另填对应的 OpenAI Key。</p></div><p><a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">OpenAI API Key ↗</a> · <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">DeepSeek API Key ↗</a></p><label for="api-voice">OpenAI 朗读音色</label><select class="field" id="api-voice">${MOBILE_VOICES.map(voice=>`<option ${voice===(config.voice||'coral')?'selected':''}>${voice}</option>`).join('')}</select><p>朗读：gpt-4o-mini-tts。发音准备好后，可再次点击美音播放。</p><div id="settings-result" role="status"></div><div class="dialog-actions"><button type="button" class="secondary" data-close>取消</button><button class="primary" type="submit">保存设置</button></div></form>`;
  const clearKeyInputs=()=>dialog.querySelectorAll('input[type="password"]').forEach(input=>input.value='');
  dialog.showModal();dialog.querySelector('[data-close]').onclick=()=>{clearKeyInputs();dialog.close()};dialog.onclose=clearKeyInputs;
  dialog.querySelector('#export-progress').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(store,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download=`开口iPad学习记录-${today}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
  dialog.querySelector('#clear-learning-records').onclick=openClearLearningRecords;
  const checkConnection=async()=>{const status=dialog.querySelector('#online-service-status'),button=dialog.querySelector('#check-online-service');button.disabled=true;status.textContent='正在检查在线连接…';try{await chat.getConfig();status.textContent=chat.configured?'在线服务已连接，本页语音配置就绪。':'在线服务已连接，请填写本页 API Key。';status.dataset.state='online'}catch{status.textContent='暂时无法连接在线语音，请检查网络后重试。教材和已缓存原音仍可学习。';status.dataset.state='offline'}finally{button.disabled=false}};
  dialog.querySelector('#check-online-service').onclick=checkConnection;checkConnection();
  $('#api-provider').onchange=event=>{const deepseek=event.target.value==='deepseek';$('#api-key-label').textContent=`${deepseek?'DeepSeek':'OpenAI'} API Key`;$('#speech-key-fields').hidden=!deepseek;clearKeyInputs()};
  dialog.querySelector('form').onsubmit=async event=>{
    event.preventDefault();const button=event.currentTarget.querySelector('[type=submit]');button.disabled=true;
    let learningSaved=false;
    try{
      const next={...store,startDate:$('#setting-start').value||store.startDate,accent:'en-US'};
      if(!persist(next)){$('#settings-result').textContent='学习设置尚未保存，请检查浏览器存储后重试。';return}
      learningSaved=true;
      const selectedProvider=$('#api-provider').value,requested={provider:selectedProvider,model:selectedProvider==='deepseek'?'deepseek-v4-pro':provider==='openai'?config.model||'gpt-4.1-mini':'gpt-4.1-mini',voice:$('#api-voice').value},apiKey=$('#api-key').value.trim(),speechKey=$('#speech-key').value.trim();
      const configureRequested=Boolean(apiKey||speechKey)||Object.keys(initialVoiceConfig).some(key=>requested[key]!==initialVoiceConfig[key]);
      if(configureRequested)await chat.configure({...requested,apiKey,speechKey});
      clearKeyInputs();dialog.close();render();
      toast(configureRequested?'学习设置已保存，美音朗读已在本页配置。':chat.configured?'学习设置已保存。':'学习设置已保存；在线美音朗读尚未配置，可继续学习教材和原音。');
    }catch(error){$('#settings-result').textContent=`${learningSaved?'学习设置已保存；在线美音朗读配置未完成：':''}${error.message||'请检查后重试。'}`}
    finally{button.disabled=false}
  };
}
function openClearLearningRecords(){
  const dialog=$('#clear-records-dialog');
  dialog.innerHTML=`<h2 id="clear-records-title">清除所有学习记录？</h2><p>将清除所有课程进度、学习历史、复习记录、每周抽课记录和日历打卡。</p><p>课程内容、音频、学习偏好和 API 设置会保留。此操作无法撤销，建议先导出学习记录备份。</p><div id="clear-records-result" role="status"></div><div class="dialog-actions"><button type="button" class="secondary" data-cancel-clear autofocus>取消</button><button type="button" class="danger-button danger-solid" data-confirm-clear>确认清除</button></div>`;
  dialog.querySelector('[data-cancel-clear]').onclick=()=>dialog.close();
  dialog.querySelector('[data-confirm-clear]').onclick=()=>{
    const cleared=clearLearningRecords(store);
    try{localStorage.setItem('kaikou-ipad-v1',JSON.stringify(cleared))}catch{$('#clear-records-result').textContent='浏览器未能保存清除结果，学习记录尚未清除，请重试。';return}
    stopMedia();Object.assign(store,cleared);
    Object.assign(ui,{page:'home',dialogue:0,stage:0,line:0,review:null,showTranscript:false,speed:1,reviewDate:today,month:today.slice(0,7)});
    dialog.close();$('#settings-dialog').close();render();
    toast('此 iPad 版学习记录已清除。');
  };
  dialog.showModal();
}
function openPronunciation(turnIndex,chunkIndex){
  const line=dialogue().lines[turnIndex],chunks=line.chunks?.length?line.chunks:[{en:line.en,zh:line.zh}],chunk=chunks[chunkIndex],dialog=$('#settings-dialog');
  let selected=chunk.en;
  const words=chunk.en.match(/(?:[ap]\.m\.|(?:Mr|Mrs|Ms|Dr)\.|[A-Za-z]+(?:['’][A-Za-z]+)?|\d+(?::\d+)?)/gi)||[];
  dialog.innerHTML=`<h2 class="word-title">${esc(chunk.en)}</h2>${words.length>1?`<div class="word-chips"><button data-whole-phrase>整个词组</button>${words.map((word,index)=>`<button data-pronounce-word="${index}">${esc(word)}</button>`).join('')}</div>`:''}<div class="accent-buttons"><button class="secondary" id="pronounce-us">${icon('volume')}美音</button></div><div class="dialog-actions"><button class="secondary" data-close>关闭</button></div>`;
  dialog.showModal();
  dialog.querySelector('#pronounce-us').onclick=()=>pronounce(selected);
  dialog.querySelectorAll('[data-pronounce-word]').forEach(button=>button.onclick=()=>{const word=words[Number(button.dataset.pronounceWord)];selected=/^\d{2,5}$/.test(word)&&/\broom\b/i.test(chunk.en)?`room ${word}`:word;dialog.querySelector('.word-title').textContent=normalizeEnglishPunctuation(word);pronounce(selected)});
  dialog.querySelector('[data-whole-phrase]')?.addEventListener('click',()=>{selected=chunk.en;dialog.querySelector('.word-title').textContent=normalizeEnglishPunctuation(chunk.en);pronounce(selected)});
  dialog.querySelector('[data-close]').onclick=()=>{stopTts();dialog.close()};
  pronounce(selected);
}

function chooseStage(stage){stopMedia();ui.stage=stage;ui.speed=stage===4?3:1;ui.line=0;ui.showTranscript=false;render()}
function chooseCourse(id){
  stopMedia();store.selectedLesson=Number(id);ui.review=null;ui.line=0;ui.page='home';ui.showTranscript=false;ui.chatScenario='';ui.speed=1;
  const unfinished=lesson().dialogues.findIndex((d,index)=>!getDialogueCompletion(store,lesson().id,index));
  ui.dialogue=Math.max(0,unfinished);ui.stage=0;
  persist();chat.reset();render();
}
function finishDialogue(){
  if(recordState.status==='recording'){toast('先结束录音，再完成本对话。');return}
  today=toDateKey(new Date());
  const next=createStore(JSON.parse(JSON.stringify(store)));
  if(ui.review){
    const {dueDate,offset}=ui.review,indices=reviewDialogueIndices(next,lesson().id,dueDate,offset);
    if(!indices.includes(ui.dialogue)||dueDate>today){toast('这段对话不在本次到期复习中。');return}
    markReviewed(next,dueDate,lesson().id,offset,ui.dialogue,today);
    if(!persist(next))return;
    stopMedia();
    if(indices.every(index=>isReviewed(store,dueDate,lesson().id,offset,index))){ui.page='reviews';ui.review=null;toast('本次对话复习已完成。')}
    else toast('本对话复习已记录。');
    render();return;
  }
  const result=completeDialogue(next,{lessonId:lesson().id,title:lesson().title,dialogueIndex:ui.dialogue,dialogueTitle:dialogue().title,date:today});
  if(!persist(next))return;
  stopMedia();render();toast(result.alreadyCompleted?'本对话已完成，首次完成日期保留。':result.complete?'本课 5 段对话已全部完成，复习计划已更新。':'本对话已完成，已加入 0、1、3、7 天复习计划。');
}
function shiftMonth(amount){const date=new Date(`${ui.month}-01T12:00:00`);date.setMonth(date.getMonth()+amount);ui.month=toDateKey(date).slice(0,7);render()}
function bind(){
  document.querySelectorAll('[data-page]').forEach(button=>button.onclick=()=>{if(!VISIBLE_PAGES.has(button.dataset.page))return;stopMedia();chat.cancelRecording();ui.page=button.dataset.page;if(ui.page==='home')ui.review=null;render();$('.page').scrollTop=0});
  document.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>action(button.dataset.action));
  document.querySelectorAll('[data-stage]').forEach(button=>button.onclick=()=>chooseStage(Number(button.dataset.stage)));
  document.querySelectorAll('[data-dialogue]').forEach(button=>button.onclick=()=>{stopMedia();ui.dialogue=Number(button.dataset.dialogue);ui.line=0;ui.showTranscript=false;render()});
  document.querySelectorAll('[data-speed]').forEach(button=>button.onclick=()=>playFull(Number(button.dataset.speed)));
  document.querySelectorAll('[data-course]').forEach(button=>button.onclick=()=>chooseCourse(button.dataset.course));
  document.querySelectorAll('[data-chunk]').forEach(button=>button.onclick=()=>{const [turn,chunk]=button.dataset.chunk.split(':').map(Number);openPronunciation(turn,chunk)});
  document.querySelectorAll('[data-turn-audio]').forEach(button=>button.onclick=()=>{const span=sentenceSegment(Number(button.dataset.turnAudio));if(span){stopMedia();player.play(span)}else toast('这一轮原音尚未对齐。')});
  document.querySelectorAll('[data-calendar-date]').forEach(button=>button.onclick=()=>openCheckin(button.dataset.calendarDate));
  document.querySelectorAll('[data-review]').forEach(button=>button.onclick=()=>{const [id,date,offset,index]=button.dataset.review.split('|');if(date>today){toast('这项复习还未到期。');return}const indices=reviewDialogueIndices(store,Number(id),date,offset);if(!indices.length){toast('这项复习没有已完成的对话。');return}chooseCourse(id);ui.review={dueDate:date,offset};ui.dialogue=index!==''&&indices.includes(Number(index))?Number(index):indices.find(i=>!isReviewed(store,date,Number(id),offset,i))??indices[0];chooseStage(7)});
  document.querySelectorAll('[data-review-done]').forEach(button=>button.onclick=()=>{const [id,date,offset,index]=button.dataset.reviewDone.split('|');if(date>today){toast('这项复习还未到期。');return}const next=createStore(JSON.parse(JSON.stringify(store)));markReviewed(next,date,Number(id),offset,index===''?undefined:Number(index),today);if(persist(next))render()});
  $('#audio-seek')?.addEventListener('input',event=>{const target=Number(event.target.value);if(playerState.id!==dialogue().id){player.play({url:audioInfo().url,start:0,end:audioInfo().duration,speed:ui.speed,id:dialogue().id})}player.seek(target)});
  $('#noise-level')?.addEventListener('input',event=>{store.noiseVolume=Number(event.target.value);$('#noise-value').textContent=`${store.noiseVolume}%`;syncAmbience();persist()});
  $('#noise-scene')?.addEventListener('change',event=>{store.noiseScene=event.target.value;persist();syncAmbience()});
  $('#review-date')?.addEventListener('change',event=>{if(event.target.value){ui.reviewDate=event.target.value;render()}});
  $('#plan-start')?.addEventListener('change',event=>{if(event.target.value){store.startDate=event.target.value;persist();render()}});
  $('#scenario-select')?.addEventListener('change',event=>{chat.reset();ui.chatScenario=event.target.value;render()});
}
async function action(name){
  if(!SCENARIO_PRACTICE_ENABLED&&['chat-start','chat-record','chat-cancel','chat-stop','reset-chat'].includes(name))return;
  switch(name){
    case 'settings':openSettings();break;
    case 'checkin':openCheckin();break;
    case 'toggle-en':ui.showEn=!ui.showEn;render();break;
    case 'toggle-zh':ui.showZh=!ui.showZh;render();break;
    case 'toggle-transcript':ui.showTranscript=!ui.showTranscript;render();break;
    case 'complete-dialogue':finishDialogue();break;
    case 'next-stage':chooseStage(Math.min(8,ui.stage+1));break;
    case 'previous-stage':chooseStage(Math.max(0,ui.stage-1));break;
    case 'listen-sentence':if(playerState.id===`${dialogue().id}:sentence:${ui.line}`&&playerState.status==='playing')player.stop();else await playSentence();break;
    case 'next-line':case 'previous-line':stopMedia();ui.line=Math.max(0,Math.min(sentences().length-1,ui.line+(name==='next-line'?1:-1)));ui.showTranscript=false;render();break;
    case 'toggle-player':if(ownsPlayback()&&['playing','loading','resuming'].includes(playerState.status))player.pause();else if(ownsPlayback()&&playerState.status==='paused')await player.resume();else await playFull();break;
    case 'stop-player':player.stop();break;
    case 'record':if(recordState.status==='recording')recordings.stop();else{if(ui.stage!==6)player.stop();stopTts();recordings.start(recordingKey())}break;
    case 'replay':if(recordState.status==='recording'){toast('请先结束录音，再回听。');return}player.stop();stopTts();recordings.toggleReplay(recordingKey());break;
    case 'pause-replay':recordings.pauseReplay();break;
    case 'stop-replay':recordings.stopReplay();break;
    case 'previous-month':shiftMonth(-1);break;
    case 'next-month':shiftMonth(1);break;
    case 'review-today':ui.reviewDate=today;render();break;
    case 'chat-start':stopMedia();await chat.startConversation();break;
    case 'chat-record':player.stop();recordings.stopReplay();stopTts();if(chatState.status==='recording')await chat.stopRecording();else await chat.startRecording();break;
    case 'chat-cancel':chat.cancelRecording();break;
    case 'chat-stop':chat.stopPlayback();chatState=chat.snapshot;renderChat();break;
    case 'reset-chat':chat.reset();ui.chatModes={};break;
  }
}

async function loadJson(url,fallback=null){const response=await fetch(url,{cache:'no-store'});if(!response.ok){if(fallback)return loadJson(fallback);throw new Error(`文件未能加载：${url}`)}return response.json()}
async function bootstrap(){
  try{
    [curriculum,manifest,ambiences]=await Promise.all([loadJson('data/curriculum.json'),loadJson('data/audio-manifest.json'),loadJson('data/ambience.json').catch(()=>[])]);
    persist();render();chat.getConfig().catch(()=>{});
  }catch(error){$('#app').innerHTML=`<div class="load-error"><h1>教材还未准备好</h1><p>${esc(error.message)}</p><button onclick="location.reload()">重新加载</button></div>`}
}
function suspendPage(){stopMedia();recordings.stream?.getTracks().forEach(track=>track.stop());chat.suspend();chatState=chat.snapshot;if(curriculum)syncRecording()}
document.addEventListener('visibilitychange',()=>{if(document.hidden)suspendPage()});
window.addEventListener('pagehide',()=>{suspendPage();chat.suspend({clearCredentials:true});$('#settings-dialog')?.querySelectorAll('input[type="password"]').forEach(input=>input.value='')});
window.addEventListener('beforeunload',()=>{recordings.destroy();player.destroy();chat.destroy();stopTts();stopAmbience()});
window.addEventListener('focus',()=>{const date=toDateKey(new Date());if(date!==today){today=date;ui.reviewDate=date;render()}});
bootstrap();
