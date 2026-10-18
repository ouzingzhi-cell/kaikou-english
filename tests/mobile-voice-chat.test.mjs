import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {MobileVoiceChat} from '../public/studio/mobile-voice-chat.js';

const primary = 'fixture-primary-only-memory';
const speech = 'fixture-speech-only-memory';
const response = (data, ok = true) => ({ok, json:async () => data});
const assistant = {id:'a1', role:'assistant', en:'Welcome!', zh:'欢迎！', audioUrl:'data:audio/mpeg;base64,AAAA'};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise, resolve}; };
const turn = () => new Promise(resolve => setImmediate(resolve));

class Page extends EventTarget { hidden = false; }
class Recorder {
  static isTypeSupported(type) { return type === 'audio/mp4'; }
  constructor(stream, {mimeType} = {}) { this.stream=stream; this.mimeType=mimeType; this.state='inactive'; }
  start() { this.state='recording'; }
  stop() {
    this.state='inactive';
    this.ondataavailable?.({data:new Blob(['public-test-recording'], {type:this.mimeType})});
    this.onstop?.();
  }
}
class Audio {
  constructor(url) { this.src=url; this.paused=true; this.currentTime=0; }
  async play() { this.paused=false; }
  pause() { this.paused=true; }
}
function setup({fetchImpl, ...options} = {}) {
  const calls=[], errors=[], changes=[], document=new Page(), window=new Page();
  let tracksStopped=0;
  const track={stop:() => tracksStopped++}, stream={getTracks:() => [track]};
  const chat=new MobileVoiceChat({visibilityTarget:document, pageTarget:window, AudioClass:Audio,
    mediaDevices:{getUserMedia:async () => stream}, MediaRecorderClass:Recorder,
    urlApi:{createObjectURL:()=>'blob:private-current-page', revokeObjectURL:()=>{}},
    onChange:value=>changes.push(value), onError:error=>errors.push(error),
    fetchImpl:async (path,init) => {
      calls.push({path,init});
      return fetchImpl ? fetchImpl(path,init,calls.length) : response(path === '/api/config' ? {configured:true} : {assistant});
    }, ...options});
  return {chat,calls,errors,changes,document,window,stream,get tracksStopped(){return tracksStopped;}};
}

test('root API paths carry keys only in headers, pure URI-encoded configuration and no-store', async () => {
  const {chat,calls}=setup();
  await chat.configure({apiKey:primary});
  await chat.sendText('Public test sentence.');
  assert.deepEqual(calls.map(call=>call.path), ['/api/config','/api/voice']);
  for (const {init} of calls) {
    assert.equal(init.headers['X-Kaikou-Key'],primary);
    assert.equal(init.credentials,'same-origin'); assert.equal(init.cache,'no-store');
    assert.equal(init.method,'POST'); assert.equal(init.headers['Content-Type'],'application/json');
    assert.ok(!init.body.includes(primary));
    const config=JSON.parse(decodeURIComponent(init.headers['X-Kaikou-Config']));
    assert.equal(config.provider,'openai'); assert.equal(config.transcriptionModel,'gpt-4o-mini-transcribe');
    assert.equal(config.speechModel,'gpt-4o-mini-tts'); assert.ok(!JSON.stringify(config).includes(primary));
  }
  assert.ok(!JSON.stringify(chat.snapshot).includes(primary));
  chat.destroy();
});

test('DeepSeek requires distinct speech credentials and locks V4 Pro', async () => {
  const {chat,calls}=setup();
  await assert.rejects(chat.configure({provider:'deepseek',apiKey:primary}),{code:'CONFIG_REQUIRED'});
  await assert.rejects(chat.configure({provider:'deepseek',apiKey:primary,speechKey:primary}),{code:'CONFIG_INVALID'});
  assert.equal(calls.length,0);
  await chat.configure({provider:'deepseek',apiKey:primary,speechKey:speech,model:'another-model'});
  assert.equal(chat.config.model,'deepseek-v4-pro'); assert.equal(chat.config.requiresSpeechKey,true);
  assert.equal(calls[0].init.headers['X-Kaikou-Speech-Key'],speech);
  assert.ok(!JSON.stringify(chat.snapshot).includes(speech));
  chat.destroy();
});

test('provider changes cannot reuse the other service key; same-provider blank fields retain session key', async () => {
  const {chat,calls}=setup();
  await chat.configure({apiKey:primary}); await chat.configure({voice:'marin'});
  assert.equal(calls.at(-1).init.headers['X-Kaikou-Key'],primary);
  await assert.rejects(chat.configure({provider:'deepseek',speechKey:speech}),{code:'CONFIG_REQUIRED'});
  assert.equal(calls.length,2); chat.destroy();
});

test('configuration snapshots ignore reflected secrets and unrecognized server config fields', async () => {
  const {chat}=setup({fetchImpl:()=>response({configured:true,apiKey:primary,speechKey:speech,untrusted:{key:primary}})});
  await chat.configure({apiKey:primary}); await chat.getConfig();
  assert.ok(!JSON.stringify(chat.snapshot).includes(primary));
  assert.ok(!JSON.stringify(chat.snapshot).includes(speech));
  assert.equal(chat.snapshot.config.persistence,'page-memory'); chat.destroy();
});

test('no credential storage API is accessed and missing credentials block voice requests', async () => {
  const originals=['localStorage','sessionStorage','indexedDB','caches'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
  for (const [key] of originals) Object.defineProperty(globalThis,key,{configurable:true,get(){throw Error('Persistent storage forbidden');}});
  try {
    const {chat,calls}=setup();
    assert.equal(await chat.sendText('Hello'),null); assert.equal(calls.length,0);
    await chat.configure({apiKey:primary}); await chat.getConfig(); chat.destroy();
  } finally {
    for (const [key,descriptor] of originals) if(descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];
  }
});

test('backgrounding cancels recording, releases tracks and does not upload', async () => {
  const state=setup(); await state.chat.configure({apiKey:primary});
  assert.equal(await state.chat.startRecording(),true);
  assert.equal(state.chat._recorder.mimeType,'audio/mp4');
  state.document.hidden=true; state.document.dispatchEvent(new Event('visibilitychange')); await turn();
  assert.equal(state.chat.status,'idle'); assert.ok(state.tracksStopped>0);
  assert.equal(state.calls.filter(call=>call.path==='/api/voice').length,0);
  assert.equal(state.chat.messages.length,0); state.chat.destroy();
});

test('background during pending microphone permission releases later stream without recording or sending', async () => {
  const permission=deferred();
  const state=setup({mediaDevices:{getUserMedia:()=>permission.promise}});
  await state.chat.configure({apiKey:primary}); const start=state.chat.startRecording(); await turn();
  state.document.hidden=true;state.document.dispatchEvent(new Event('visibilitychange'));
  permission.resolve(state.stream); assert.equal(await start,false);
  assert.ok(state.tracksStopped>0); assert.equal(state.chat.status,'idle');
  assert.equal(state.calls.filter(call=>call.path==='/api/voice').length,0);state.chat.destroy();
});

test('pagehide clears keys and aborts a pending configuration without restoring credentials', async () => {
  const pending=deferred();const state=setup({fetchImpl:()=>pending.promise});
  const configure=state.chat.configure({apiKey:primary});
  state.window.dispatchEvent(new Event('pagehide'));
  assert.equal(state.calls[0].init.signal.aborted,true);
  pending.resolve(response({configured:true}));
  await assert.rejects(configure,{name:'AbortError'});
  assert.equal(state.chat.configured,false);
  assert.equal(await state.chat.sendText('Hello'),null);
  assert.equal(state.calls.length,1);state.chat.destroy();
});

test('NotAllowedError leaves AI reply intact with tap-to-play guidance instead of AI failure', async () => {
  class BlockedAudio extends Audio { async play(){throw new DOMException('Gesture required','NotAllowedError');} }
  const state=setup({AudioClass:BlockedAudio}); await state.chat.configure({apiKey:primary});await state.chat.startConversation();
  assert.equal(await state.chat.togglePlayback('a1'),false);
  assert.match(state.chat.snapshot.playbackHint,/点击语音气泡/);
  assert.equal(state.chat.snapshot.error,null); assert.equal(state.errors.length,0);
  assert.equal(state.chat.messages[0].failed,undefined);assert.equal(state.chat.messages[0].audioUrl,assistant.audioUrl);
  state.chat.destroy();
});

test('in-flight playback stopped by background cannot revive playing state or error on rejection', async () => {
  const pending=deferred();class PendingAudio extends Audio {play(){return pending.promise;}}
  const state=setup({AudioClass:PendingAudio});await state.chat.configure({apiKey:primary});await state.chat.startConversation();
  const playing=state.chat.togglePlayback('a1');state.document.hidden=true;state.document.dispatchEvent(new Event('visibilitychange'));
  pending.resolve();assert.equal(await playing,false);assert.equal(state.chat.playingId,null);assert.equal(state.errors.length,0);state.chat.destroy();
});

test('assistant speech retry reuses existing text without another voice/model request', async () => {
  const state=setup({fetchImpl:path=>path==='/api/config'?response({configured:true}):path==='/api/voice'
    ?response({error:{code:'AI_TTS',stage:'speech',retryable:true,message:'Speech unavailable'},assistant:{...assistant,audioUrl:null}},false)
    :response({audioUrl:assistant.audioUrl,mimeType:'audio/mpeg'})});
  await state.chat.configure({apiKey:primary});await state.chat.startConversation();
  assert.equal(state.chat.messages[0].needsAudio,true);await state.chat.retryAudio('a1');
  assert.deepEqual(state.calls.map(call=>call.path),['/api/config','/api/voice','/api/tts']);
  assert.equal(state.chat.messages[0].needsAudio,false);assert.equal(state.chat.messages[0].audioUrl,assistant.audioUrl);state.chat.destroy();
});

test('recorded user blob remains local when backend returns audioUrl null; sends once on explicit stop', async () => {
  const state=setup({fetchImpl:path=>response(path==='/api/config'?{configured:true}:{user:{id:'server-user',role:'user',en:'Hello',zh:'你好',audioUrl:null},assistant})});
  await state.chat.configure({apiKey:primary});await state.chat.startRecording();await state.chat.stopRecording();
  assert.equal(state.calls.filter(call=>call.path==='/api/voice').length,1);
  assert.equal(state.chat.messages[0].audioUrl,'blob:private-current-page');
  assert.equal(state.chat.messages[0].en,'Hello');assert.ok(state.tracksStopped>0);state.chat.destroy();
});

test('iPad application uses its isolated progress key and never auto-plays asynchronous AI replies', async () => {
  const source=await readFile(new URL('../public/studio/application.js',import.meta.url),'utf8');
  assert.match(source,/localStorage\.getItem\('kaikou-ipad-v1'\)\|\|'\{\}'/);
  assert.ok(!source.includes("'kaikou-v2'")&&!source.includes("'kaikou-v1'")&&!source.includes('kaikou-windows-local'));
  assert.ok(!source.includes('queueMicrotask(()=>chat.togglePlayback'));
  assert.ok(!source.includes('双击“启动应用”')&&!source.includes('本地语音识别'));
  assert.match(source,/pagehide/);assert.match(source,/visibilitychange/);
});

async function settingsHarness({configured=false, configure, canPersist=true, offline=false}={}) {
  const source=await readFile(new URL('../public/studio/application.js',import.meta.url),'utf8');
  const openSettings=source.slice(source.indexOf('function openSettings(){'),source.indexOf('\nfunction openClearLearningRecords()'));
  const elements=new Map();
  const element=selector=>{
    if(!elements.has(selector))elements.set(selector,{value:'',disabled:false,textContent:'',dataset:{}});
    return elements.get(selector);
  };
  const values={'#setting-start':'2026-10-20','#setting-accent':'en-US','#api-provider':'openai','#api-model':'gpt-4.1-mini','#api-voice':'coral','#api-key':'','#speech-key':''};
  for(const [selector,value]of Object.entries(values))element(selector).value=value;
  const saved=[],calls=[],toasts=[],store={startDate:'2026-10-01',accent:'en-GB',progress:{'1:0':[0]}};
  let closed=0,renders=0;
  const form={querySelector:element};
  const dialog={showModal(){},close(){closed++;this.onclose?.()},querySelector:selector=>selector==='form'?form:element(selector),querySelectorAll:()=>[element('#api-key'),element('#speech-key')]};
  const chat={configured,getConfig:async()=>{if(offline)throw Error('Offline');return{configured}},configure:async value=>{calls.push(value);return configure?configure(value):{configured:true}}};
  const context={$:selector=>selector==='#settings-dialog'?dialog:element(selector),chat,chatState:{configured,config:{provider:'openai',model:'gpt-4.1-mini',voice:'coral'}},store,MOBILE_VOICES:['coral','marin'],esc:String,today:'2026-10-18',openClearLearningRecords(){},render(){renders++},toast:message=>toasts.push(message),persist:next=>{if(!canPersist)return false;saved.push(JSON.parse(JSON.stringify(next)));Object.assign(store,next);return true}};
  runInNewContext(`${openSettings}\nopenSettings();`,context);
  await turn();
  return {element,saved,calls,toasts,store,chat,get closed(){return closed},get renders(){return renders},submit:()=>form.onsubmit({preventDefault(){},currentTarget:form})};
}

test('offline settings save date and accent without keys or AI configuration request',async()=>{
  const state=await settingsHarness({offline:true});await state.submit();
  assert.equal(state.store.startDate,'2026-10-20');assert.equal(state.store.accent,'en-US');
  assert.deepEqual(state.store.progress,{'1:0':[0]});assert.equal(state.saved.length,1);assert.equal(state.calls.length,0);
  assert.equal(state.closed,1);assert.equal(state.chat.configured,false);
  assert.match(state.toasts[0],/在线语音尚未配置/);assert.ok(!state.toasts[0].includes('已在本页配置'));
});

test('changing AI settings without keys keeps learning preferences saved and shows configuration error',async()=>{
  const state=await settingsHarness({configure:()=>{throw Error('请填写 OpenAI API Key。')}});
  state.element('#api-voice').value='marin';await state.submit();
  assert.equal(state.saved.length,1);assert.equal(state.store.accent,'en-US');assert.equal(state.calls.length,1);
  assert.equal(state.closed,0);assert.equal(state.chat.configured,false);
  assert.match(state.element('#settings-result').textContent,/学习设置已保存；在线语音配置未完成/);
  assert.match(state.element('#settings-result').textContent,/请填写 OpenAI API Key/);
  assert.equal(state.element('[type=submit]').disabled,false);
});

test('explicit key triggers AI configuration after preferences persist and never enters saved record',async()=>{
  const state=await settingsHarness();state.element('#api-key').value=primary;await state.submit();
  assert.equal(state.calls.length,1);assert.equal(state.calls[0].apiKey,primary);
  assert.equal(state.saved.length,1);assert.ok(!JSON.stringify(state.saved).includes(primary));
  assert.equal(state.element('#api-key').value,'');assert.equal(state.closed,1);
  assert.match(state.toasts[0],/在线语音已在本页配置/);
});

test('configured session with untouched AI fields only saves learning preferences',async()=>{
  const state=await settingsHarness({configured:true});await state.submit();
  assert.equal(state.calls.length,0);assert.equal(state.chat.configured,true);assert.equal(state.closed,1);
  assert.deepEqual(state.toasts,['学习设置已保存。']);
});

test('storage failure neither mutates learning preferences nor sends new credentials',async()=>{
  const state=await settingsHarness({canPersist:false});state.element('#api-key').value=primary;await state.submit();
  assert.equal(state.calls.length,0);assert.equal(state.closed,0);assert.equal(state.store.startDate,'2026-10-01');
  assert.equal(state.store.accent,'en-GB');assert.equal(state.saved.length,0);
  assert.match(state.element('#settings-result').textContent,/学习设置尚未保存/);
  assert.equal(state.element('[type=submit]').disabled,false);
});
