import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileApiHandler, parseVoiceModelResponse, MAX_AUDIO_BYTES, MAX_BODY_BYTES } from '../lib/mobile-api.mjs';

const ORIGIN = 'https://learn.example';
const OPENAI_KEY = 'sk-openai-fixture-12345678901234567890';
const DEEPSEEK_KEY = 'sk-deepseek-fixture-12345678901234567890';
const OTHER_KEY = 'sk-other-fixture-12345678901234567890';
const AUDIO = btoa('fixture recorded audio');
const RESPONSE = { assistantEn: 'Of course. Would you like a window seat?', assistantZh: '当然。你想要靠窗的座位吗？', userZh: '我想预订一张桌子。' };
const j = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const answer = (value = RESPONSE) => j({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const deepAnswer = (value = RESPONSE) => j({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value), reasoning_content: 'PRIVATE reasoning must not be exposed' } }] });
const speech = () => new Response(new Uint8Array([73, 68, 51, 1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } });

function request(path, payload, { provider = 'openai', key = OPENAI_KEY, speechKey, config = {}, headers = {}, signal, method } = {}) {
  const verb = method || (payload === undefined ? 'GET' : 'POST');
  return new Request(`${ORIGIN}/api/${path}`, { method: verb, signal,
    headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin',
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-Kaikou-Config': encodeURIComponent(JSON.stringify({ provider, ...config })),
      ...(key === undefined || key === null ? {} : { 'X-Kaikou-Key': key }),
      ...(speechKey === undefined ? {} : { 'X-Kaikou-Speech-Key': speechKey }), ...headers },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

function mockApi(replies, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init, json: typeof init.body === 'string' ? JSON.parse(init.body) : null });
    const next = replies.shift();
    assert.ok(next, `Unexpected upstream request ${url}`);
    return typeof next === 'function' ? next(url, init) : next;
  };
  return { calls, handler: createMobileApiHandler({ fetchImpl, now: () => Date.UTC(2026, 9, 18), ...options }) };
}

test('configuration is sanitized, request-scoped, and never makes an upstream request', async () => {
  const { handler, calls } = mockApi([]);
  const saved = await handler(request('config', {}, { config: { model: 'gpt-4.1-mini', speechModel: 'gpt-4o-mini-tts' } }));
  const text = await saved.text(), configured = JSON.parse(text);
  assert.equal(saved.status, 200);
  assert.equal(configured.configured, true);
  assert.equal(configured.voice, 'coral');
  assert.equal(configured.persistence, 'page-memory');
  assert.equal(configured.requiresSpeechKey, false);
  assert.ok(configured.voices.includes('marin'));
  assert.equal(text.includes(OPENAI_KEY), false);
  const fresh = await (await handler(request('config', undefined, { key: null }))).json();
  assert.equal(fresh.configured, false);
  assert.equal(calls.length, 0);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert.equal(saved.headers.get('access-control-allow-origin'), null);
});

test('legacy config POST accepts explicit provider + body key, with header priority', async () => {
  const { handler } = mockApi([]);
  const bodyOnly = new Request(`${ORIGIN}/api/config`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'deepseek', apiKey: DEEPSEEK_KEY, speechApiKey: OPENAI_KEY }) });
  const response = await handler(bodyOnly), text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(text).configured, true);
  assert.equal(JSON.parse(text).requiresSpeechKey, true);
  assert.equal(text.includes(OPENAI_KEY) || text.includes(DEEPSEEK_KEY), false);
  const headerWins = await (await handler(request('config', { provider: 'deepseek', apiKey: DEEPSEEK_KEY }, { key: OPENAI_KEY, config: { model: 'gpt-4.1-mini', voice: 'marin' } }))).json();
  assert.equal(headerWins.provider, 'openai');
  assert.equal(headerWins.voice, 'marin');
});

test('OpenAI opening, recorded turn, and text turn preserve conversation and schemas', async () => {
  const { handler, calls } = mockApi([answer(), speech(), j({ text: 'I want book a table.' }), answer(), speech(), answer(), speech()]);
  const opening = await (await handler(request('voice', { mode: 'start', scenario: { title: 'Restaurant' }, learnedContext: 'Would you like ...', accent: 'en-GB' }))).json();
  assert.equal(opening.user, undefined);
  assert.equal(opening.assistant.role, 'assistant');
  assert.match(opening.assistant.audioUrl, /^data:audio\/mpeg;base64,/);
  assert.equal(opening.assistant.aiGenerated, true);
  const recorded = await (await handler(request('voice', { mode: 'voice', mimeType: 'audio/mp4;codecs=mp4a.40.2', audioBase64: AUDIO, messages: [opening.assistant], accent: 'en-US' }))).json();
  assert.equal(recorded.user.en, 'I want book a table.');
  assert.equal(recorded.user.audioUrl, null);
  assert.equal(recorded.user.zh, RESPONSE.userZh);
  assert.equal(recorded.assistant.needsAudio, false);
  const typed = await (await handler(request('voice', { mode: 'text', text: 'Yes, please.', messages: [opening.assistant, recorded.user, recorded.assistant] }))).json();
  assert.equal(typed.user.en, 'Yes, please.');
  assert.equal(calls.length, 7);
  assert.ok(calls.every(call => call.url.startsWith('https://api.openai.com/v1/')));
  assert.ok(calls.every(call => call.headers.Authorization === `Bearer ${OPENAI_KEY}`));
  const transcription = calls[2].body;
  assert.ok(transcription instanceof FormData);
  assert.equal(transcription.get('model'), 'gpt-4o-mini-transcribe');
  assert.equal(transcription.get('language'), 'en');
  assert.equal(transcription.get('response_format'), 'json');
  assert.equal(transcription.get('file').type, 'audio/mp4');
  assert.equal(await transcription.get('file').text(), 'fixture recorded audio');
  const generation = calls[3].json;
  assert.equal(generation.model, 'gpt-4.1-mini');
  assert.equal(generation.store, false);
  assert.equal(generation.text.format.strict, true);
  assert.equal(generation.text.format.schema.additionalProperties, false);
  assert.equal(generation.input.at(-2).content, opening.assistant.en);
  assert.equal(generation.input.at(-1).content, 'I want book a table.');
  assert.equal(calls[5].json.input.at(-2).content, recorded.assistant.en);
  assert.match(calls[4].json.instructions, /American English/);
  assert.match(calls[6].json.instructions, /British English/);
  assert.equal(calls[4].json.model, 'gpt-4o-mini-tts');
  assert.equal(calls[4].json.response_format, 'mp3');
});

test('DeepSeek multi-turn uses Pro only and sends ASR/TTS exclusively the separate OpenAI key', async () => {
  const opts = { provider: 'deepseek', key: DEEPSEEK_KEY, speechKey: OPENAI_KEY };
  const { handler, calls } = mockApi([deepAnswer(), speech(), j({ text: 'A window seat, please.' }), deepAnswer(), speech(), deepAnswer(), speech()]);
  const opening = await (await handler(request('voice', { mode: 'start' }, opts))).json();
  const turn = await (await handler(request('voice', { mode: 'voice', mimeType: 'audio/webm;codecs=opus', audioBase64: AUDIO, messages: [opening.assistant] }, opts))).json();
  const next = await handler(request('voice', { mode: 'text', text: 'Thank you.', messages: [opening.assistant, turn.user, turn.assistant] }, opts));
  assert.equal(next.status, 200);
  for (const call of calls) {
    if (call.url === 'https://api.deepseek.com/chat/completions') {
      assert.equal(call.headers.Authorization, `Bearer ${DEEPSEEK_KEY}`);
      assert.equal(call.json.model, 'deepseek-v4-pro');
      assert.equal(call.json.thinking.type, 'disabled');
      assert.equal(call.json.response_format.type, 'json_object');
      assert.equal(call.json.stream, false);
    } else {
      assert.ok(call.url.startsWith('https://api.openai.com/v1/audio/'));
      assert.equal(call.headers.Authorization, `Bearer ${OPENAI_KEY}`);
      assert.notEqual(call.headers.Authorization, `Bearer ${DEEPSEEK_KEY}`);
    }
    assert.equal(call.redirect, 'error');
  }
  assert.equal(calls[3].json.messages.at(-2).content, opening.assistant.en);
  assert.equal(calls[5].json.messages.at(-2).content, turn.assistant.en);
  assert.equal(JSON.stringify(turn).includes('PRIVATE reasoning'), false);
});

test('missing or identical DeepSeek speech credentials block every upstream call', async () => {
  const { handler, calls } = mockApi([]);
  const missing = await handler(request('voice', { mode: 'start' }, { provider: 'deepseek', key: DEEPSEEK_KEY }));
  assert.equal((await missing.json()).error.code, 'SPEECH_KEY_REQUIRED');
  const same = await handler(request('voice', { mode: 'voice', mimeType: 'audio/webm', audioBase64: AUDIO }, { provider: 'deepseek', key: DEEPSEEK_KEY, speechKey: DEEPSEEK_KEY }));
  assert.equal((await same.json()).error.code, 'KEY_PROVIDER_MISMATCH');
  assert.equal(calls.length, 0);
});

test('concurrent requests do not share credentials, provider, model, or selected voice', async () => {
  const calls = [];
  const handler = createMobileApiHandler({ fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, key: init.headers.Authorization, body });
    await new Promise(resolve => setTimeout(resolve, 1));
    return url.endsWith('/audio/speech') ? speech() : url.includes('deepseek') ? deepAnswer() : answer();
  } });
  const [a, b] = await Promise.all([
    handler(request('voice', { mode: 'text', text: 'First learner.' }, { key: OTHER_KEY, config: { model: 'gpt-4.1-mini-2025-04-14', voice: 'marin' } })),
    handler(request('voice', { mode: 'text', text: 'Second learner.' }, { provider: 'deepseek', key: DEEPSEEK_KEY, speechKey: OPENAI_KEY, config: { voice: 'cedar' } })),
  ]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(calls.find(call => call.body.model === 'deepseek-v4-pro').key, `Bearer ${DEEPSEEK_KEY}`);
  assert.equal(calls.find(call => call.body.voice === 'cedar').key, `Bearer ${OPENAI_KEY}`);
  assert.equal(calls.find(call => call.body.voice === 'marin').key, `Bearer ${OTHER_KEY}`);
  assert.equal(calls.find(call => call.body.model === 'gpt-4.1-mini-2025-04-14').key, `Bearer ${OTHER_KEY}`);
  const fresh = await (await handler(request('config', undefined, { key: null }))).json();
  assert.equal(fresh.configured, false);
});

test('a failed reply retains the exact transcript and can retry as text without another ASR call', async () => {
  const { handler, calls } = mockApi([j({ text: 'I has a reservation.' }), j({ private: OPENAI_KEY }, 500), answer(), speech()]);
  const failed = await handler(request('voice', { mode: 'voice', mimeType: 'audio/ogg', audioBase64: AUDIO }));
  const partial = await failed.json();
  assert.equal(failed.status, 502);
  assert.equal(partial.error.stage, 'reply');
  assert.equal(partial.error.retryable, true);
  assert.equal(partial.user.en, 'I has a reservation.');
  assert.equal(partial.assistant, undefined);
  const retried = await handler(request('voice', { mode: 'text', text: partial.user.en }));
  assert.equal(retried.status, 200);
  assert.equal(calls.filter(call => call.url.endsWith('/audio/transcriptions')).length, 1);
  assert.equal(calls.at(-2).json.input.at(-1).content, 'I has a reservation.');
});

test('failed TTS retains both completed messages, and audio-only retry preserves the reply', async () => {
  const { handler, calls } = mockApi([answer(), j({ error: { message: OPENAI_KEY } }, 429), speech()]);
  const failed = await handler(request('voice', { mode: 'text', text: 'I want a table.', accent: 'en-US' }));
  const partial = await failed.json();
  assert.equal(failed.status, 429);
  assert.equal(partial.error.stage, 'speech');
  assert.equal(partial.error.retryable, true);
  assert.equal(partial.user.en, 'I want a table.');
  assert.equal(partial.assistant.en, RESPONSE.assistantEn);
  assert.equal(partial.assistant.zh, RESPONSE.assistantZh);
  assert.equal(partial.assistant.audioUrl, null);
  assert.equal(partial.assistant.needsAudio, true);
  const retried = await handler(request('tts', { text: partial.assistant.en, accent: partial.assistant.requestedAccent }));
  assert.equal(retried.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1).json.input, RESPONSE.assistantEn);
  assert.match(calls.at(-1).json.instructions, /American English/);
});

test('transcription failure and empty ASR never invent user speech or call text generation', async () => {
  const { handler, calls } = mockApi([j({ private: 'do not disclose' }, 500), j({ text: '   ' }), new Response('invalid ASR body')]);
  for (const expected of ['AI_UPSTREAM', 'NO_SPEECH', 'AI_TRANSCRIPTION']) {
    const result = await (await handler(request('voice', { mimeType: 'audio/wav', audioBase64: AUDIO }))).json();
    assert.equal(result.error.code, expected);
    assert.equal(result.error.stage, 'transcription');
    assert.equal(result.user.en, '');
    assert.equal(result.user.audioUrl, null);
    assert.equal(result.assistant, undefined);
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.url.endsWith('/audio/transcriptions')));
});

test('one format recovery keeps the explicit model and ignores private reasoning', async () => {
  const { handler, calls } = mockApi([
    j({ choices: [{ finish_reason: 'stop', message: { content: null, reasoning_content: 'PRIVATE reasoning' } }] }),
    deepAnswer(), speech(),
  ]);
  const response = await handler(request('voice', { mode: 'text', text: 'Hello.' }, { provider: 'deepseek', key: DEEPSEEK_KEY, speechKey: OPENAI_KEY }));
  const text = await response.text(), result = JSON.parse(text);
  assert.equal(response.status, 200);
  assert.equal(result.recovery.attempts, 2);
  assert.equal(result.recovery.formats[0].category, 'reasoning-only');
  assert.equal(text.includes('PRIVATE reasoning'), false);
  assert.deepEqual(calls.slice(0, 2).map(call => call.json.model), ['deepseek-v4-pro', 'deepseek-v4-pro']);
  assert.match(calls[1].json.messages[0].content, /previous attempt/);
});

test('malformed provider JSON has one recovery; exhausted failures retain the completed user', async () => {
  const { handler, calls } = mockApi([new Response('not json'), answer(), speech(), j({ output_text: '{}' }), j({ output_text: 'no final JSON' })]);
  const recovered = await (await handler(request('voice', { mode: 'text', text: 'Hello.' }, { config: { model: 'gpt-4.1-mini-2025-04-14' } }))).json();
  assert.equal(recovered.recovery.attempts, 2);
  assert.equal(calls[0].json.model, 'gpt-4.1-mini-2025-04-14');
  assert.equal(calls[1].json.model, 'gpt-4.1-mini-2025-04-14');
  const failed = await handler(request('voice', { mode: 'text', text: 'Try again.' }));
  const result = await failed.json();
  assert.equal(failed.status, 502);
  assert.equal(result.error.code, 'AI_RESPONSE');
  assert.equal(result.error.retryable, true);
  assert.equal(result.error.stage, 'reply');
  assert.equal(result.user.en, 'Try again.');
  assert.equal(calls.length, 5);
});

test('refusal does not trigger format recovery and is not retryable', async () => {
  const { handler, calls } = mockApi([j({ status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'private refusal text' }] }] })]);
  const result = await (await handler(request('voice', { mode: 'text', text: 'Hello.' }))).json();
  assert.equal(result.error.code, 'AI_REFUSAL');
  assert.equal(result.error.retryable, false);
  assert.equal(result.user.en, 'Hello.');
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(result).includes('private refusal text'), false);
});

test('provider errors, transport errors, and diagnostics never expose keys or error bodies', async () => {
  let cancelledBody = false;
  const privateResponse = new Response(new ReadableStream({ cancel() { cancelledBody = true; } }), { status: 401 });
  const { handler } = mockApi([privateResponse, () => { throw new Error(`private ${OPENAI_KEY}`); }, answer({ ...RESPONSE, assistantEn: `Echoed credential ${OPENAI_KEY}` }), speech()]);
  for (const expected of ['AI_AUTH', 'AI_NETWORK']) {
    const response = await handler(request('voice', { mode: 'text', text: 'Hello.' })), text = await response.text();
    assert.equal(JSON.parse(text).error.code, expected);
    assert.equal(text.includes(OPENAI_KEY), false);
    assert.equal(text.includes('private'), false);
  }
  assert.equal(cancelledBody, true);
  const reflected = await (await handler(request('voice', { mode: 'text', text: 'Hello.' }))).text();
  assert.equal(reflected.includes(OPENAI_KEY), false);
  assert.match(reflected, /已隐藏密钥/);
  const parsed = parseVoiceModelResponse({ choices: [{ finish_reason: OPENAI_KEY, message: { content: JSON.stringify(RESPONSE) } }] }, 'deepseek');
  assert.equal(parsed.diagnostics.finishReason, null);
});

test('request origin, sec-fetch-site, JSON type, unknown paths, and models are validated before any charge', async () => {
  const { handler, calls } = mockApi([]);
  const cases = [
    [request('voice', { mode: 'start' }, { headers: { Origin: 'https://other.example' } }), 403, 'ORIGIN_BLOCKED'],
    [request('voice', { mode: 'start' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'ORIGIN_BLOCKED'],
    [request('voice', { mode: 'start' }, { headers: { 'Sec-Fetch-Site': 'same-site' } }), 403, 'ORIGIN_BLOCKED'],
    [request('voice', { mode: 'start' }, { headers: { Origin: '' } }), 403, 'ORIGIN_REQUIRED'],
    [request('voice', { mode: 'start' }, { headers: { 'Content-Type': 'text/plain' } }), 415, 'JSON_REQUIRED'],
    [request('config', undefined, { config: { model: 'https://evil.example/' } }), 400, 'INVALID_MODEL'],
    [request('config', undefined, { provider: 'deepseek', config: { model: 'deepseek-flash' } }), 400, 'INVALID_MODEL'],
    [request('config', undefined, { config: { speechModel: 'deepseek-v4-pro' } }), 400, 'INVALID_MODEL'],
    [request('audio/random'), 404, 'NOT_FOUND'],
    [request('voice'), 405, 'METHOD_NOT_ALLOWED'],
    [request('voice', { mode: 'start' }, { key: null }), 503, 'CONFIG_REQUIRED'],
  ];
  for (const [input, status, code] of cases) { const result = await handler(input); assert.equal(result.status, status); assert.equal((await result.json()).error.code, code); }
  assert.equal(calls.length, 0);
});

test('invalid audio, malformed JSON, and audio limits are rejected without upstream calls', async () => {
  const { handler, calls } = mockApi([]);
  for (const [payload, expected] of [
    [{ mode: 'voice', mimeType: 'text/plain', audioBase64: AUDIO }, 'AUDIO_FORMAT'],
    [{ mode: 'voice', mimeType: 'audio/webm', audioBase64: '%%%=' }, 'INVALID_AUDIO'],
    [{ mode: 'voice', mimeType: 'audio/webm', audioBase64: '====' }, 'INVALID_AUDIO'],
    [{ mode: 'voice', mimeType: 'audio/webm', audioBase64: 'A'.repeat(Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4) }, 'INVALID_AUDIO'],
    [{ mode: 'text', text: ' ' }, 'EMPTY_TEXT'],
    [{ mode: 'unknown' }, 'INVALID_MODE'],
  ]) assert.equal((await (await handler(request('voice', payload))).json()).error.code, expected);
  const invalid = new Request(`${ORIGIN}/api/voice`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{bad json' });
  assert.equal((await (await handler(invalid)).json()).error.code, 'INVALID_JSON');
  assert.equal(calls.length, 0);
});

function streamedRequest(chunks, headers = {}) {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); }, cancel() { cancelled = true; } });
  return { request: new Request(`${ORIGIN}/api/voice`, { method: 'POST', duplex: 'half', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: stream }), wasCancelled: () => cancelled };
}

test('incoming streamed bodies are bounded by actual bytes as well as declared size', async () => {
  const { handler, calls } = mockApi([]);
  const declared = streamedRequest([new Uint8Array(1)], { 'Content-Length': String(MAX_BODY_BYTES + 1) });
  assert.equal((await handler(declared.request)).status, 413);
  const actual = streamedRequest([new Uint8Array(MAX_BODY_BYTES), new Uint8Array(1)]);
  const oversized = await handler(actual.request);
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'UPLOAD_TOO_LARGE');
  assert.equal(calls.length, 0);
});

test('upstream text and audio are bounded while streaming, with partial messages retained', async () => {
  const over = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_AUDIO_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } }), { headers: { 'Content-Type': 'audio/mpeg' } });
  const { handler, calls } = mockApi([over(), answer(), over()]);
  const replyTooLarge = await (await handler(request('voice', { mode: 'text', text: 'Hello.' }))).json();
  assert.equal(replyTooLarge.error.code, 'UPSTREAM_TOO_LARGE');
  assert.equal(replyTooLarge.error.stage, 'reply');
  assert.equal(replyTooLarge.user.en, 'Hello.');
  const audioTooLarge = await (await handler(request('voice', { mode: 'text', text: 'Again.' }))).json();
  assert.equal(audioTooLarge.error.code, 'UPSTREAM_TOO_LARGE');
  assert.equal(audioTooLarge.error.stage, 'speech');
  assert.equal(audioTooLarge.assistant.needsAudio, true);
  assert.equal(calls.length, 3);
});

test('upstream deadlines cover response bodies, and cancellation aborts fetch with partial state', async () => {
  let bodyCancelled = false;
  const { handler } = mockApi([new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }))], { timeoutMs: 10 });
  const timeout = await handler(request('voice', { mode: 'text', text: 'Hello.' }));
  const timedOut = await timeout.json();
  assert.equal(timeout.status, 504);
  assert.equal(timedOut.error.code, 'AI_TIMEOUT');
  assert.equal(timedOut.user.en, 'Hello.');
  assert.equal(bodyCancelled, true);
  let seenSignal;
  const abortable = createMobileApiHandler({ fetchImpl: async (_url, init) => { seenSignal = init.signal; return new Promise(() => {}); } });
  const controller = new AbortController();
  const pending = abortable(request('voice', { mode: 'text', text: 'Cancel me.' }, { signal: controller.signal }));
  while (!seenSignal) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort();
  const cancelled = await pending, partial = await cancelled.json();
  assert.equal(cancelled.status, 499);
  assert.equal(partial.error.code, 'CANCELLED');
  assert.equal(partial.user.en, 'Cancel me.');
  assert.equal(seenSignal.aborted, true);
});

test('upload timeout aborts an unfinished streamed request', async () => {
  let uploadCancelled = false;
  const stream = new ReadableStream({ cancel() { uploadCancelled = true; } });
  const input = new Request(`${ORIGIN}/api/voice`, { method: 'POST', duplex: 'half', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: stream });
  const { handler } = mockApi([], { uploadTimeoutMs: 10 });
  const response = await handler(input);
  assert.equal(response.status, 408);
  assert.equal((await response.json()).error.code, 'UPLOAD_TIMEOUT');
  assert.equal(uploadCancelled, true);
});

test('final-answer parser supports bounded recovery formats and rejects incomplete or reasoning-only output', () => {
  for (const [text, category] of [
    [JSON.stringify(RESPONSE), 'json'],
    [`\uFEFF\`\`\`json\n${JSON.stringify(RESPONSE)}\n\`\`\``, 'json-fence'],
    [`Here is the reply: ${JSON.stringify(RESPONSE)}`, 'embedded-json'],
    [JSON.stringify(JSON.stringify(RESPONSE)), 'json'],
  ]) {
    const result = parseVoiceModelResponse({ output_text: text }, 'openai');
    assert.equal(result.reply.assistantEn, RESPONSE.assistantEn);
    assert.equal(result.diagnostics.category, category);
  }
  assert.throws(() => parseVoiceModelResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: JSON.stringify(RESPONSE) }, 'openai'), error => error.diagnostics.category === 'truncated');
  assert.throws(() => parseVoiceModelResponse({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify(RESPONSE) } }] }, 'deepseek'), error => error.diagnostics.category === 'truncated');
  assert.throws(() => parseVoiceModelResponse({ choices: [{ message: { content: null, reasoning_content: 'PRIVATE' } }] }, 'deepseek'), error => error.diagnostics.category === 'reasoning-only' && !JSON.stringify(error).includes('PRIVATE'));
  assert.throws(() => parseVoiceModelResponse({ output: [{ type: 'reasoning', content: [{ type: 'output_text', text: JSON.stringify(RESPONSE) }] }] }, 'openai'), error => error.diagnostics.category === 'content-empty');
});
