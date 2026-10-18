/** Real provider-backed voice messages. No canned replies or keys in storage. */
export class VoiceChatError extends Error {
  constructor(code, message) { super(message); this.name = 'VoiceChatError'; this.code = code; }
}

async function blobBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return btoa(binary);
}

export class VoiceChat {
  constructor({ onChange = () => {}, onError = () => {}, getContext = () => ({}), fetchImpl = globalThis.fetch, mediaDevices = globalThis.navigator?.mediaDevices, MediaRecorderClass = globalThis.MediaRecorder, AudioClass = globalThis.Audio, urlApi = globalThis.URL } = {}) {
    this.onChange = onChange;
    this.onError = onError;
    this.getContext = getContext;
    // Native Window.fetch needs its Window receiver in the in-app browser.
    this.fetchImpl = (...args) => fetchImpl.call(globalThis, ...args);
    this.mediaDevices = mediaDevices;
    this.MediaRecorderClass = MediaRecorderClass;
    this.AudioClass = AudioClass;
    this.urlApi = urlApi;
    this.messages = [];
    this.status = 'idle';
    this.configured = false;
    this.config = null;
    this.error = null;
    this.playingId = null;
    this._generation = 0;
    this._ownedUrls = new Set();
    this._retryPayloads = new Map();
    this._destroyed = false;
  }

  get snapshot() {
    return { status: this.status, messages: this.messages.map(message => ({ ...message })), playingId: this.playingId, configured: this.configured, config: this.config ? { ...this.config } : null, error: this.error };
  }

  _emit() { if (!this._destroyed) this.onChange(this.snapshot); }
  _fail(error) {
    const value = error instanceof VoiceChatError ? error : new VoiceChatError('VOICE_ERROR', '语音操作未完成，请重试。');
    this.error = value.message;
    if (value.code === 'CONFIG_REQUIRED' || value.code === 'AI_AUTH') this.configured = false;
    this.onError(value);
    this._emit();
    return value;
  }

  async _json(path, payload, signal) {
    let response;
    try {
      response = await this.fetchImpl(path, {
        method: payload === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
        signal,
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      console.warn('Voice service transport:', String(error?.name || 'Error').slice(0, 60), String(error?.message || 'Request failed').slice(0, 180));
      throw new VoiceChatError('NETWORK_ERROR', '在线语音连接未完成，请检查网络后重试。');
    }
    let result;
    try { result = await response.json(); } catch { throw new VoiceChatError('INVALID_RESPONSE', '语音服务返回了无法读取的内容，请稍后重试。'); }
    if (!response.ok) {
      const error = new VoiceChatError(result.error?.code || 'REQUEST_FAILED', result.error?.message || '语音请求未完成，请重试。');
      error.stage = result.error?.stage;
      error.retryable = result.error?.retryable;
      error.diagnostics = result.error?.diagnostics;
      error.partialUser = result.user;
      error.partialAssistant = result.assistant;
      throw error;
    }
    return result;
  }

  async getConfig() {
    try {
      const result = await this._json('/api/config');
      this.config = result; this.configured = result.configured; this._emit();
      return result;
    } catch (error) { throw this._fail(error); }
  }

  /** The apiKey argument is sent once; it is never retained by this controller. */
  async configure({ provider, apiKey, model, transcriptionModel, speechModel, voice } = {}) {
    try {
      const result = await this._json('/api/config', { provider, apiKey, model, transcriptionModel, speechModel, voice });
      this.config = result; this.configured = result.configured; this.error = null; this._emit();
      return result;
    } catch (error) { throw this._fail(error); }
  }

  _payload(extra) {
    const context = this.getContext() || {};
    const messages = this.messages.filter(message => message.en && !message.pending && (!message.failed || message.role === 'assistant' && message.needsAudio)).map(({ role, en }) => ({ role, en }));
    return { scenario: context.scenario || '', learnedContext: context.learnedContext || '', accent: context.accent || 'en-GB', messages, ...extra };
  }

  async _submit(extra, userMessage = null, generation = ++this._generation) {
    this.stopPlayback();
    this.error = null; this.status = 'thinking';
    this._controller = new AbortController();
    const controller = this._controller;
    let currentUser = userMessage;
    const receiveUser = value => {
      if (!value && !currentUser) return null;
      const merged = { ...currentUser, ...value, id: currentUser?.id || value.id,
        audioUrl: currentUser?.audioUrl || value?.audioUrl || null, duration: currentUser?.duration || value?.duration,
        pending: false, failed: false, errorCode: null, errorStage: null, errorMessage: null };
      const index = this.messages.findIndex(message => message.id === merged.id);
      if (index >= 0) this.messages[index] = merged; else this.messages.push(merged);
      currentUser = merged; return merged;
    };
    this._emit();
    try {
      const result = await this._json('/api/voice', this._payload(extra), controller.signal);
      if (generation !== this._generation || this._destroyed) return null;
      if (result.user) {
        receiveUser(result.user);
      }
      if (!result.assistant?.audioUrl || !result.assistant?.en) throw new VoiceChatError('INVALID_RESPONSE', 'AI 语音回复不完整，请重试。');
      this.messages.push(result.assistant);
      if (currentUser) this._retryPayloads.delete(currentUser.id);
      this.status = 'idle'; this.configured = true; this._emit();
      return result;
    } catch (error) {
      if (generation !== this._generation || error.name === 'AbortError' || this._destroyed) return null;
      if (error.partialUser) receiveUser(error.partialUser);
      else if (currentUser) receiveUser(null);
      if (currentUser) {
        currentUser.pending = false;
        currentUser.failed = !error.partialAssistant?.en;
        currentUser.errorCode = currentUser.failed ? error.code || 'REQUEST_FAILED' : null;
        currentUser.errorStage = currentUser.failed ? error.stage || 'request' : null;
        currentUser.errorMessage = currentUser.failed ? error.message : null;
        currentUser.retryable = error.retryable !== false;
        if (currentUser.failed) this._retryPayloads.set(currentUser.id, currentUser.en ? { mode: 'text', text: currentUser.en } : extra);
        else this._retryPayloads.delete(currentUser.id);
      }
      if (error.partialAssistant?.en) {
        const assistant = { ...error.partialAssistant, pending: false, failed: true, needsAudio: true,
          errorCode: error.code, errorStage: error.stage || 'speech', errorMessage: error.message, retryable: true };
        const index = this.messages.findIndex(message => message.id === assistant.id);
        if (index >= 0) this.messages[index] = assistant; else this.messages.push(assistant);
      }
      this.status = 'idle'; this._fail(error);
      return null;
    } finally {
      if (this._controller === controller) this._controller = null;
    }
  }

  async startConversation() {
    if (this.status !== 'idle') return null;
    return this._submit({ mode: 'start' });
  }

  async sendText(text) {
    if (this.status !== 'idle') return null;
    if (!text?.trim()) return null;
    return this._submit({ mode: 'text', text: text.trim() });
  }

  /** Reuse completed transcription, or the original recording if ASR failed. */
  async retryMessage(messageId) {
    if (this.status !== 'idle') return null;
    const message = this.messages.find(item => item.id === messageId && item.role === 'user');
    if (!message?.failed) return null;
    const payload = message.en ? { mode: 'text', text: message.en } : this._retryPayloads.get(messageId);
    if (!payload) { this._fail(new VoiceChatError('RECORDING_EXPIRED', '原录音已不在当前页面，请重新录制。')); return null; }
    message.pending = true; message.failed = false; message.errorMessage = null;
    return this._submit(payload, message);
  }

  /** The model has already replied: retry TTS only, without another model call. */
  async retryAudio(messageId) {
    if (this.status !== 'idle') return null;
    const message = this.messages.find(item => item.id === messageId && item.role === 'assistant');
    if (!message?.en || !message.needsAudio) return null;
    const generation = ++this._generation, controller = new AbortController();
    this._controller = controller;
    this.stopPlayback(); this.status = 'thinking'; this.error = null; message.pending = true; this._emit();
    try {
      const result = await this._json('/api/tts', { text: message.en, accent: message.requestedAccent || this.getContext()?.accent || 'en-GB' }, controller.signal);
      if (generation !== this._generation || this._destroyed) return null;
      Object.assign(message, result, { pending: false, failed: false, needsAudio: false, errorCode: null, errorStage: null, errorMessage: null });
      this.status = 'idle'; this._emit(); return result;
    } catch (error) {
      if (generation !== this._generation || error.name === 'AbortError' || this._destroyed) return null;
      message.pending = false; message.failed = true; this.status = 'idle'; this._fail(error); return null;
    } finally { if (this._controller === controller) this._controller = null; }
  }

  async startRecording() {
    if (this.status !== 'idle') return false;
    if (!this.mediaDevices?.getUserMedia || !this.MediaRecorderClass) {
      this._fail(new VoiceChatError('MIC_UNAVAILABLE', '请通过 HTTPS 打开页面，并在 Safari 中允许麦克风。'));
      return false;
    }
    this.status = 'requesting'; this.error = null; this.stopPlayback();
    const generation = ++this._generation;
    this._emit();
    let stream;
    try {
      const config = await this.getConfig();
      if (generation !== this._generation) return false;
      if (!config.configured) throw new VoiceChatError('CONFIG_REQUIRED', `先在 AI 设置中配置 ${config.provider === 'openai' ? 'OpenAI' : 'DeepSeek'} API Key，再发送真实语音。`);
      stream = await this.mediaDevices.getUserMedia({ audio: true });
      if (generation !== this._generation || this._destroyed) { stream.getTracks().forEach(track => track.stop()); return false; }
      const supported = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
      const mimeType = supported.find(type => this.MediaRecorderClass.isTypeSupported?.(type));
      const recorder = new this.MediaRecorderClass(stream, mimeType ? { mimeType } : undefined);
      this._recorder = recorder;
      this._stream = stream;
      const chunks = [];
      let size = 0;
      const started = Date.now();
      let finish;
      this._finished = new Promise(resolve => { finish = resolve; });
      this._finishRecording = finish;
      recorder.ondataavailable = event => {
        if (event.data.size) { chunks.push(event.data); size += event.data.size; }
        if (size > (this.config?.maxUploadBytes || 8 * 1024 * 1024)) {
          this.cancelRecording();
          this._fail(new VoiceChatError('UPLOAD_TOO_LARGE', '录音超过 8 MB，请缩短语音后重试。'));
        }
      };
      recorder.onerror = () => {
        if (generation !== this._generation) return;
        this.cancelRecording(); this._fail(new VoiceChatError('MIC_RECORDING', '录音中断，请检查麦克风后重试。'));
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        clearTimeout(this._recordTimer);
        if (this._recorder === recorder) { this._recorder = null; this._stream = null; }
        if (generation !== this._generation || this._destroyed) { finish(null); return; }
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
        if (!blob.size) {
          this.status = 'idle'; this._fail(new VoiceChatError('EMPTY_AUDIO', '没有录到声音，请重试。')); finish(null); return;
        }
        this.status = 'thinking'; this._emit();
        try {
          const audioBase64 = await blobBase64(blob);
          if (generation !== this._generation) { finish(null); return; }
          const audioUrl = this.urlApi.createObjectURL(blob);
          this._ownedUrls.add(audioUrl);
          const user = { id: `local-${Date.now()}-${generation}`, role: 'user', audioUrl, en: '', zh: '', duration: Math.max(1, Math.round((Date.now() - started) / 1000)), pending: true };
          this._retryPayloads.set(user.id, { mode: 'voice', audioBase64, mimeType: blob.type });
          this.messages.push(user); this._emit();
          const result = await this._submit({ mode: 'voice', audioBase64, mimeType: blob.type }, user, generation);
          finish(result);
        } catch (error) {
          if (generation === this._generation) { this.status = 'idle'; this._fail(error); }
          finish(null);
        }
      };
      recorder.start(250);
      this.status = 'recording';
      this._recordTimer = setTimeout(() => this.stopRecording(), (config.maxRecordingSeconds || 120) * 1000);
      this._emit(); return true;
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      if (generation !== this._generation || this._destroyed) return false;
      this.status = 'idle';
      this._fail(error.name === 'NotAllowedError' ? new VoiceChatError('MIC_DENIED', '麦克风权限未获允许，请在浏览器设置中开启。') : error);
      return false;
    }
  }

  async stopRecording() {
    const finished = this._finished;
    if (this._recorder?.state === 'recording') this._recorder.stop();
    return finished || null;
  }

  cancelRecording() {
    this._generation += 1;
    clearTimeout(this._recordTimer);
    const recorder = this._recorder;
    this._recorder = null;
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch {} }
    this._stream?.getTracks().forEach(track => track.stop()); this._stream = null;
    this._controller?.abort(); this._controller = null;
    this._finishRecording?.(null); this._finishRecording = null; this._finished = null;
    for (const message of this.messages) {
      if (!message.pending) continue;
      message.pending = false; message.failed = true; message.retryable = true;
      message.errorCode = 'CANCELLED'; message.errorStage = message.role === 'assistant' ? 'speech' : 'request';
      message.errorMessage = '已取消，可以重试这条消息。';
    }
    this.status = 'idle'; this._emit();
  }

  async togglePlayback(messageId) {
    if (this.status === 'recording' || this.status === 'requesting') return false;
    const message = this.messages.find(item => item.id === messageId);
    if (!message?.audioUrl || !this.AudioClass) return false;
    if (this._audioId === messageId && this._audio && !this._audio.paused) {
      this._audio.pause(); this.playingId = null; this._emit(); return false;
    }
    if (this._audioId !== messageId || !this._audio) {
      this.stopPlayback();
      this._audio = new this.AudioClass(message.audioUrl); this._audioId = messageId;
      const player = this._audio;
      player.onended = () => { if (this._audio === player) { this.playingId = null; this._emit(); } };
      player.onerror = () => { if (this._audio === player) { this.stopPlayback(); this._fail(new VoiceChatError('AUDIO_PLAYBACK', '音频播放失败或已过期，请重新生成。')); } };
    }
    const player = this._audio;
    try {
      await player.play();
      if (this._audio !== player) return false;
      this.playingId = messageId; this._emit(); return true;
    } catch (error) {
      if (this._audio !== player) return false;
      this.playingId = null;
      this._playbackBlocked(error);
      return false;
    }
  }

  _playbackBlocked() {
    this._fail(new VoiceChatError('AUDIO_PLAYBACK', '浏览器暂未播放音频，请再次点击语音消息。'));
  }

  stopPlayback() {
    if (this._audio) { this._audio.pause(); this._audio.currentTime = 0; }
    this._audio = null; this._audioId = null; this.playingId = null;
  }

  /** Use neural English pronunciation for sentences, phrases or individual words. */
  async tts(text, accent = 'en-GB') {
    try { return await this._json('/api/tts', { text, accent }); }
    catch (error) { throw this._fail(error); }
  }

  reset() {
    this.cancelRecording(); this.stopPlayback();
    for (const url of this._ownedUrls) this.urlApi.revokeObjectURL(url);
    this._ownedUrls.clear(); this._retryPayloads.clear(); this.messages = []; this.error = null; this._emit();
  }

  destroy() { this.reset(); this._destroyed = true; this.onChange = () => {}; this.onError = () => {}; }
}
