import {VoiceChat, VoiceChatError} from './voice-chat.js';

export const MOBILE_VOICES = ['coral', 'marin', 'cedar', 'alloy', 'sage'];
const DEFAULTS = Object.freeze({provider:'openai', model:'gpt-4.1-mini', voice:'coral',
  transcriptionModel:'gpt-4o-mini-transcribe', speechModel:'gpt-4o-mini-tts'});
const ENDPOINTS = new Set(['/api/config', '/api/voice', '/api/tts']);

function safeConfig(value = {}) {
  const provider = value.provider === 'deepseek' ? 'deepseek' : 'openai';
  return {provider, model:provider === 'deepseek' ? 'deepseek-v4-pro' : String(value.model || DEFAULTS.model).slice(0,120),
    voice:MOBILE_VOICES.includes(value.voice) ? value.voice : DEFAULTS.voice,
    transcriptionModel:DEFAULTS.transcriptionModel, speechModel:DEFAULTS.speechModel};
}
function keyValue(value) {
  const key = String(value || '').trim();
  if (key.length > 512 || /[\r\n\x00-\x1f\x7f]/.test(key)) throw new VoiceChatError('CONFIG_INVALID', 'API Key 格式无效，请重新填写。');
  return key;
}

/** Keys live only in private fields of this page, never in snapshots or storage. */
export class MobileVoiceChat extends VoiceChat {
  #key = '';
  #speechKey = '';
  #settings = {...DEFAULTS};
  #credentialEpoch = 0;
  #configController = null;

  constructor({visibilityTarget = globalThis.document, pageTarget = globalThis.window, ...options} = {}) {
    super(options);
    this.playbackHint = '';
    this._visibilityTarget = visibilityTarget;
    this._pageTarget = pageTarget;
    this._onVisibility = () => { if (visibilityTarget?.hidden) this.suspend(); };
    this._onPageHide = () => this.suspend({clearCredentials:true});
    visibilityTarget?.addEventListener('visibilitychange', this._onVisibility);
    pageTarget?.addEventListener('pagehide', this._onPageHide);
    this.config = this._publicConfig();
  }

  get snapshot() { return {...super.snapshot, playbackHint:this.playbackHint || ''}; }

  _publicConfig(result = {}) {
    return {...this.#settings, configured:Boolean(this.#key && (this.#settings.provider !== 'deepseek' || this.#speechKey)),
      voices:[...MOBILE_VOICES], persistence:'page-memory', requiresSpeechKey:this.#settings.provider === 'deepseek',
      maxRecordingSeconds:Math.min(120, Number(result.maxRecordingSeconds) || 120),
      maxUploadBytes:Math.min(8 * 1024 * 1024, Number(result.maxUploadBytes) || 8 * 1024 * 1024)};
  }

  async _json(path, payload, signal) {
    if (!ENDPOINTS.has(path)) throw new VoiceChatError('CONFIG_INVALID', '语音请求地址无效。');
    if (path !== '/api/config' && (!this.#key || this.#settings.provider === 'deepseek' && !this.#speechKey)) {
      throw new VoiceChatError('CONFIG_REQUIRED', this.#settings.provider === 'deepseek'
        ? '请在设置中填写 DeepSeek Key 和 OpenAI 语音 Key。' : '请先在设置中填写 OpenAI API Key。');
    }
    const headers = {'X-Kaikou-Config':encodeURIComponent(JSON.stringify(this.#settings))};
    if (this.#key) headers['X-Kaikou-Key'] = this.#key;
    if (this.#settings.provider === 'deepseek' && this.#speechKey) headers['X-Kaikou-Speech-Key'] = this.#speechKey;
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await this.fetchImpl(path, {method:payload === undefined ? 'GET' : 'POST', credentials:'same-origin',
        cache:'no-store', headers, ...(payload === undefined ? {} : {body:JSON.stringify(payload)}), signal});
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new VoiceChatError('NETWORK_ERROR', '在线语音连接未完成，请检查网络后重试。');
    }
    let result;
    try { result = await response.json(); }
    catch { throw new VoiceChatError('INVALID_RESPONSE', '在线语音暂时未返回有效内容，请稍后重试。'); }
    if (!response.ok) {
      const error = new VoiceChatError(result.error?.code || 'REQUEST_FAILED', result.error?.message || '语音请求未完成，请重试。');
      Object.assign(error, {stage:result.error?.stage, retryable:result.error?.retryable,
        partialUser:result.user, partialAssistant:result.assistant});
      throw error;
    }
    return result;
  }

  async getConfig() {
    const epoch = this.#credentialEpoch;
    try {
      const result = await this._json('/api/config');
      if (epoch !== this.#credentialEpoch || this._destroyed) return this._publicConfig();
      this.config = this._publicConfig(result); this.configured = this.config.configured && result.configured !== false;
      this.config.configured = this.configured; this._emit(); return this.config;
    } catch (error) { throw this._fail(error); }
  }

  async configure({provider, apiKey, speechKey, ...settings} = {}) {
    const epoch = ++this.#credentialEpoch;
    this.#configController?.abort();
    const controller = new AbortController(); this.#configController = controller;
    const previous = {key:this.#key, speechKey:this.#speechKey, settings:this.#settings};
    try {
      const providerChanged = provider && provider !== this.#settings.provider;
      const next = safeConfig({...this.#settings, ...(providerChanged ? {model:DEFAULTS.model} : {}),
        ...settings, ...(provider ? {provider} : {})});
      const switched = next.provider !== this.#settings.provider;
      const key = apiKey?.trim() ? keyValue(apiKey) : switched ? '' : this.#key;
      const speech = speechKey?.trim() ? keyValue(speechKey) : switched ? '' : this.#speechKey;
      if (!key || next.provider === 'deepseek' && !speech) throw new VoiceChatError('CONFIG_REQUIRED', next.provider === 'deepseek'
        ? 'DeepSeek 需要自己的 Key，并另填 OpenAI 语音 Key 用于识别和朗读。' : '请填写 OpenAI API Key。');
      if (next.provider === 'deepseek' && key === speech) throw new VoiceChatError('CONFIG_INVALID', 'DeepSeek 和 OpenAI 来自不同服务，请分别填写各自的 Key。');
      this.cancelRecording(); this.stopPlayback();
      this.#settings = next; this.#key = key; this.#speechKey = next.provider === 'deepseek' ? speech : '';
      const result = await this._json('/api/config', next, controller.signal);
      if (epoch !== this.#credentialEpoch || this._destroyed) throw new DOMException('Page configuration cancelled', 'AbortError');
      if (result.configured === false) throw new VoiceChatError('CONFIG_REQUIRED', '在线语音配置未完成，请检查 Key。');
      this.config = this._publicConfig(result); this.configured = true; this.error = null; this.playbackHint = ''; this._emit();
      return this.config;
    } catch (error) {
      if (epoch !== this.#credentialEpoch || this._destroyed) throw new DOMException('Page configuration cancelled', 'AbortError');
      this.#key = previous.key; this.#speechKey = previous.speechKey; this.#settings = previous.settings;
      throw this._fail(error);
    } finally { if (this.#configController === controller) this.#configController = null; }
  }

  _playbackBlocked(error) {
    if (error?.name === 'NotAllowedError') {
      this.playbackHint = '语音已准备好，请点击语音气泡播放。'; this._emit();
    } else super._playbackBlocked(error);
  }

  async togglePlayback(messageId) {
    this.playbackHint = '';
    return super.togglePlayback(messageId);
  }

  suspend({clearCredentials = false} = {}) {
    this.cancelRecording(); this.stopPlayback(); this.playbackHint = '';
    if (clearCredentials) {
      ++this.#credentialEpoch; this.#configController?.abort(); this.#configController = null;
      this.#key = ''; this.#speechKey = '';
      this.config = this._publicConfig(); this.configured = false;
    }
    this._emit();
  }

  destroy() {
    this._visibilityTarget?.removeEventListener('visibilitychange', this._onVisibility);
    this._pageTarget?.removeEventListener('pagehide', this._onPageHide);
    ++this.#credentialEpoch; this.#configController?.abort(); this.#configController = null;
    this.#key = ''; this.#speechKey = '';
    super.destroy();
  }
}
