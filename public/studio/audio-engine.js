/** One selected source segment, one pass. All progress values are segment-relative. */
export class SegmentPlayer {
  constructor({onChange=()=>{},onError=()=>{},AudioClass=globalThis.Audio}={}) {
    this.audio=new AudioClass();this.onChange=onChange;this.onError=onError;
    this.audio.preload='metadata';this.segment=null;this.status='idle';this.token=0;this.timer=null;
    this.pendingSeek=null;this.cancelMetadataWait=null;
    this.audio.addEventListener('timeupdate',()=>this.tick());
    this.audio.addEventListener('ended',()=>this.stop());
    this.audio.addEventListener('error',()=>{this.stop();this.onError('音频未能加载，请检查本地服务。')});
  }
  get snapshot(){const s=this.segment,current=this.pendingSeek??this.audio.currentTime;return {status:this.status,id:s?.id||null,speed:s?.speed||1,
    position:s?Math.max(0,Math.min(current-s.start,s.end-s.start)):0,duration:s?Math.max(0,s.end-s.start):0};}
  emit(){this.onChange(this.snapshot)}
  tick(){
    if(this.status==='playing'&&this.segment&&this.audio.currentTime>=this.segment.end-.025){this.stop();return}
    this.emit();
  }
  async play({url,start=0,end,speed=1,id=''}){
    this.stop();const token=++this.token;
    if(!url||!Number.isFinite(start)||start<0||!Number.isFinite(end)||end<=start)throw new Error('这段原音的边界尚未准备好。');
    this.segment={url,start,end,speed,id};this.pendingSeek=start;this.status='loading';this.emit();
    const source=new URL(url,globalThis.location?.href||'http://localhost/').href;
    if(this.audio.src!==source){this.audio.src=source;this.audio.load()}
    return this.startPlayback(token);
  }
  waitForMetadata(){
    if(this.audio.readyState>=1)return Promise.resolve(true);
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);this.audio.removeEventListener('loadedmetadata',done);this.audio.removeEventListener('error',failed);if(this.cancelMetadataWait===cancel)this.cancelMetadataWait=null};
      const done=()=>{cleanup();resolve(true)},failed=()=>{cleanup();reject(new Error('无法读取音频'))},cancel=()=>{cleanup();resolve(false)};
      const timer=setTimeout(()=>{cleanup();reject(new Error('音频加载超时'))},20000);
      this.cancelMetadataWait=cancel;
      this.audio.addEventListener('loadedmetadata',done,{once:true});this.audio.addEventListener('error',failed,{once:true});
    });
  }
  async startPlayback(token){
    try{
      if(token!==this.token||!this.segment)return false;
      if(this.audio.readyState<1&&!await this.waitForMetadata())return false;
      if(token!==this.token)return false;
      if(this.pendingSeek!==null){this.audio.currentTime=this.pendingSeek;this.pendingSeek=null}
      this.audio.playbackRate=this.segment.speed;this.audio.preservesPitch=true;
      const playback=this.audio.play();
      // Native play() can take time to settle after it has started the audio.
      // Expose a pausable state immediately and never let its old promise revive it.
      this.status='playing';this.startTimer();this.emit();
      await playback;
      return token===this.token&&this.status==='playing';
    }catch(error){if(token===this.token){this.stop();this.onError(error.message)}return false}
  }
  startTimer(){clearInterval(this.timer);this.timer=setInterval(()=>this.tick(),25)}
  pause(){if(this.status!=='playing'&&this.status!=='loading')return false;++this.token;this.cancelMetadataWait?.();this.audio.pause();clearInterval(this.timer);this.timer=null;this.status='paused';this.emit();return true}
  async resume(){if(!this.segment||this.status!=='paused')return false;const token=++this.token;this.status='loading';this.emit();return this.startPlayback(token)}
  seek(seconds){if(!this.segment||!Number.isFinite(seconds))return;const target=this.segment.start+Math.max(0,Math.min(seconds,this.segment.end-this.segment.start));if(this.audio.readyState<1)this.pendingSeek=target;else{this.audio.currentTime=target;this.pendingSeek=null}this.emit()}
  stop(){
    ++this.token;this.cancelMetadataWait?.();clearInterval(this.timer);this.timer=null;this.audio.pause();
    // Reset to the selected span's beginning, including before metadata is ready.
    const start=this.segment?.start??0;
    this.pendingSeek=this.segment?start:null;
    if(this.audio.readyState>=1){try{this.audio.currentTime=start;this.pendingSeek=null}catch{}}
    this.status='idle';this.emit();
  }
  destroy(){this.stop();this.audio.removeAttribute('src');this.audio.load()}
}

/** Local recordings are private. Playback is a toggle, with explicit pause and stop. */
export class RecordingBank {
  constructor({onChange=()=>{},onError=()=>{}}={}){
    this.onChange=onChange;this.onError=onError;this.items=new Map();this.status='idle';this.token=0;this.currentKey=null;this.replay=null;this.replayKey=null;
  }
  get snapshot(){return {status:this.status,key:this.currentKey,replayKey:this.replayKey,replayStatus:this.replay?(this.replay.paused?'paused':'playing'):'idle'}}
  emit(){this.onChange(this.snapshot)}
  async start(key){
    if(this.status!=='idle')return;
    if(!navigator.mediaDevices?.getUserMedia||!globalThis.MediaRecorder){this.onError('请使用支持麦克风的浏览器，通过 localhost 打开应用。');return}
    this.stopReplay();const token=++this.token;this.status='requesting';this.currentKey=key;this.emit();
    let stream,recorder;
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:true});
      if(token!==this.token){stream.getTracks().forEach(t=>t.stop());return}
      const mime=['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(m=>MediaRecorder.isTypeSupported(m));
      recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);const chunks=[];
      this.recorder=recorder;this.stream=stream;
      recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data)};
      recorder.onstop=()=>{
        stream.getTracks().forEach(t=>t.stop());
        if(chunks.length){const blob=new Blob(chunks,{type:recorder.mimeType});const previous=this.items.get(key);if(previous)URL.revokeObjectURL(previous.url);this.items.set(key,{url:URL.createObjectURL(blob),blob})}
        this.emit();
      };
      recorder.start();this.status='recording';this.emit();
    }catch(error){
      stream?.getTracks().forEach(track=>track.stop());
      if(token!==this.token)return;
      if(this.recorder===recorder)this.recorder=null;
      if(this.stream===stream)this.stream=null;
      this.status='idle';this.currentKey=null;
      this.onError(error.name==='NotAllowedError'?'请允许麦克风权限后重试。':'麦克风未能启动，请检查设备。');this.emit();
    }
  }
  stop(){++this.token;if(this.recorder?.state==='recording')this.recorder.stop();else this.stream?.getTracks().forEach(t=>t.stop());this.status='idle';this.emit()}
  has(key){return this.items.has(key)}
  toggleReplay(key){
    if(this.replayKey===key&&this.replay&&!this.replay.paused){this.stopReplay();return}
    if(this.replayKey===key&&this.replay?.paused){this.replay.play().then(()=>this.emit()).catch(()=>this.onError('录音回放失败'));return}
    this.stopReplay();const item=this.items.get(key);if(!item)return;
    this.replay=new Audio(item.url);this.replayKey=key;this.replay.onended=()=>this.stopReplay();
    this.replay.play().then(()=>this.emit()).catch(()=>{this.stopReplay();this.onError('录音回放失败')});
  }
  pauseReplay(){this.replay?.pause();this.emit()}
  stopReplay(){if(this.replay){this.replay.pause();this.replay.currentTime=0;this.replay=null}this.replayKey=null;this.emit()}
  destroy(){this.stop();this.stopReplay();for(const item of this.items.values())URL.revokeObjectURL(item.url)}
}
