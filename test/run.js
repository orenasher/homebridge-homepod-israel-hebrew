'use strict';
// Offline test: mocks Homebridge, the TTS engines and the python/pyatv helper.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hih-'));
const callsLog = path.join(tmp, 'calls.log');
const fakePython = path.join(tmp, 'python');
// Fake python: argv = -I speak.py '<json>'
fs.writeFileSync(fakePython, `#!/usr/bin/env node
const reply = (a) => {
  require('fs').appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify(a) + '\\n');
  if (a.cmd === 'warm') return { ok: true, known: (a.devices || []).length };
  if (a.cmd === 'ping') return { ok: true, online: a.host !== '10.0.0.99' };
  if (a.cmd === 'scan') return { ok: true, devices: [{ name: 'מטבח', host: '10.0.0.5', id: 'AA', homepod: true }] };
  if (a.host === '10.0.0.99') return { ok: false, error: 'HomePod not found on the network' };
  return { ok: true, previousVolume: 35, warnings: [] };
};
const first = JSON.parse(process.argv[4] || '{}');
if (first.cmd === 'serve') {
  require('fs').appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify({ cmd: 'serve-start' }) + '\\n');
  console.log(JSON.stringify({ ok: true, ready: true }));
  require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
    const a = JSON.parse(l); const r = reply(a); r.rid = a.rid;
    setTimeout(() => console.log(JSON.stringify(r)), 20);
  });
  return;
}
const a = first;
require('fs').appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify(a) + '\\n');
if (a.cmd === 'check') { console.log(JSON.stringify({ ok: true, pyatv: 'test' })); process.exit(0); }
if (a.cmd === 'scan') { console.log(JSON.stringify({ ok: true, devices: [{ name: 'מטבח', host: '10.0.0.5', id: 'AA', homepod: true }] })); process.exit(0); }
if (a.host === '10.0.0.99') { console.log(JSON.stringify({ ok: false, error: 'HomePod not found on the network' })); process.exit(4); }
console.log(JSON.stringify({ ok: true, previousVolume: 35, warnings: [] }));
`);
fs.chmodSync(fakePython, 0o755);

const tts = require('../src/tts');
let edgeFail = false;
const generated = [];
tts.engines.edge = async (text, opts, out) => {
  if (edgeFail) throw new Error('edge down');
  generated.push({ voice: opts.voice, rate: opts.rate, pitch: opts.pitch, text });
  fs.writeFileSync(out, Buffer.alloc(1000, 1));
};
tts.engines.googletranslate = async (text, opts, out) => {
  generated.push({ voice: 'translate', text });
  fs.writeFileSync(out, Buffer.alloc(1000, 2));
};
tts.engines.googlecloud = async () => { throw new Error('API key is missing'); };

// --- minimal Homebridge mock
class Characteristic extends EventEmitter {
  constructor() { super(); this.value = false; }
  onGet(fn) { this.getter = fn; return this; }
  onSet(fn) { this.setter = fn; return this; }
  updateValue(v) { this.value = v; return this; }
}
class Service {
  constructor(name, type, subtype) { this.name = name; this.UUID = type; this.subtype = subtype; this.chars = new Map(); }
  setCharacteristic() { return this; }
  testCharacteristic() { return false; }
  addOptionalCharacteristic() {}
  getCharacteristic(c) { if (!this.chars.has(c)) this.chars.set(c, new Characteristic()); return this.chars.get(c); }
}
class PlatformAccessory {
  constructor(name, uuid) { this.displayName = name; this.UUID = uuid; this.context = {}; this.services = [new Service('info', 'info')]; }
  getService(t) { return this.services.find((s) => s.UUID === (t.UUID || t)); }
  getServiceById(t, sub) { return this.services.find((s) => s.UUID === (t.UUID || t) && s.subtype === sub); }
  addService(t, n, sub) { const s = new Service(n, t.UUID || t, sub); this.services.push(s); return s; }
  removeService(s) { this.services = this.services.filter((x) => x !== s); }
}
const api = new EventEmitter();
api.hap = { Service: { AccessoryInformation: { UUID: 'info' }, Switch: { UUID: 'switch' }, ContactSensor: { UUID: 'contact' } },
  Characteristic: { On: 'On', Name: 'Name', ConfiguredName: 'CN', Manufacturer: 'm', Model: 'mo', SerialNumber: 's',
    ContactSensorState: Object.assign('CSS', { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 }) },
  uuid: { generate: (s) => require('crypto').createHash('md5').update(s).digest('hex') } };
api.platformAccessory = PlatformAccessory;
api.user = { storagePath: () => tmp };
const registered = [];
api.registerPlatformAccessories = (p, n, a) => registered.push(...a);
api.updatePlatformAccessories = () => {};
api.unregisterPlatformAccessories = () => {};
const logs = [];
const log = { info: (m) => logs.push('I ' + m), warn: (m) => logs.push('W ' + m), error: (m) => logs.push('E ' + m), debug: () => {} };

let Platform;
require('../index')({ registerPlatform: (plugin, name, cls) => { Platform = cls; } });

const config = {
  platform: 'HomePodIsraelHebrew',
  pythonPath: fakePython,
  speakers: [
    { name: 'מטבח', id: 'AA', host: '10.0.0.5', volume: 40 },
    { name: 'חדר שינה הורים', id: 'BB', host: '10.0.0.6' },
    { name: 'Broken', host: '10.0.0.99' },
  ],
  phrases: [
    'ארוחת ערב מוכנה! כולם לשולחן',                                  // legacy string → all speakers
    { text: 'הכביסה מוכנה', speakers: ['מטבח'], voice: 'avri-deep', volume: 70 },
    { text: 'לילה טוב', name: 'Good night', speakers: ['מטבח', 'חדר שינה הורים'] },
    { text: '   ' },
  ],
  voice: 'hila-calm',
  webhook: { enabled: true, port: 18096, token: 'secret' },
};

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: 18096, path: p, method, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = () => (fs.existsSync(callsLog) ? fs.readFileSync(callsLog, 'utf8').trim().split('\n').map(JSON.parse) : []);
const speakCalls = () => calls().filter((c) => c.cmd === 'speak');

(async () => {
  const platform = new Platform(log, config, api);
  api.emit('didFinishLaunching');
  await sleep(400);

  assert.deepStrictEqual(registered.map((a) => a.displayName), ['ארוחת ערב מוכנה כולם לשולחן', 'הכביסה מוכנה', 'Good night']);
  assert.ok(generated.some((g) => g.voice === 'he-IL-AvriNeural' && g.pitch === '-4Hz'), 'legacy avri-deep → avri + announcer style');
  assert.ok(generated.some((g) => g.voice === 'he-IL-HilaNeural' && g.rate === '-18%'), 'legacy hila-calm → hila + calm style');

  // 1. phrase with one speaker + volume
  fs.rmSync(callsLog, { force: true });
  registered[1].getService('switch').getCharacteristic('On').setter(true);
  await sleep(300);
  let sc = speakCalls();
  assert.strictEqual(sc.length, 1);
  assert.strictEqual(sc[0].host, '10.0.0.5');
  assert.strictEqual(sc[0].volume, 70);
  assert.strictEqual(sc[0].restore, true);

  // 2. phrase with two speakers → both, in parallel; default speaker volume used
  fs.rmSync(callsLog, { force: true });
  registered[2].getService('switch').getCharacteristic('On').setter(true);
  await sleep(300);
  sc = speakCalls();
  assert.deepStrictEqual(sc.map((c) => c.host).sort(), ['10.0.0.5', '10.0.0.6']);
  assert.strictEqual(sc.find((c) => c.host === '10.0.0.5').volume, 40);
  assert.strictEqual(sc.find((c) => c.host === '10.0.0.6').volume, null);

  // fast mode: one long-running helper for everything so far, HomePods warmed at startup
  const allCalls = calls();
  assert.ok(!allCalls.some((c) => c.cmd === 'serve-start'), 'log was reset after start');

  // 3. phrase with no speakers → all, broken one fails but others play
  fs.rmSync(callsLog, { force: true });
  const r0 = await platform.announce(platform.items()[0]);
  assert.deepStrictEqual(r0.failed, ['Broken']);
  assert.strictEqual(speakCalls().length, 3);

  assert.strictEqual(platform.engine.daemon && platform.engine.daemon.alive, true, 'fast-mode helper is running');
  const pidBefore = platform.engine.daemon.child.pid;

  // 4. webhook
  let r = await req('GET', '/say?text=hi');
  assert.strictEqual(r.status, 401);
  r = await req('POST', '/say', JSON.stringify({ text: 'שלום', speakers: 'חדר שינה הורים', voice: 'avri' }),
    { 'Content-Type': 'application/json', Authorization: 'Bearer secret' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.voice, 'avri');
  r = await req('GET', '/announce?token=secret&name=good%20night&wait=0');
  assert.strictEqual(r.status, 202);
  r = await req('GET', '/status?token=secret');
  assert.strictEqual(r.json.voiceEngine, 'ready');

  assert.strictEqual(platform.engine.daemon.child.pid, pidBefore, 'same helper process reused');
  // helper crash → next announcement restarts it transparently
  platform.engine.daemon.child.kill();
  await sleep(200);
  const rr = await platform.say('אחרי קריסה', { speakers: 'מטבח' });
  assert.deepStrictEqual(rr.failed, []);
  assert.notStrictEqual(platform.engine.daemon.child.pid, pidBefore, 'helper restarted');

  // 5. fallback: google without key → hila → translate when edge is down
  const a1 = await platform.tts.getAudio('טקסט', 'google-kore');
  assert.strictEqual(a1.voice, 'hila');
  edgeFail = true;
  const a2 = await platform.tts.getAudio('טקסט אחר', 'google-kore');
  assert.strictEqual(a2.voice, 'translate');
  edgeFail = false;

  // 6. voices
  const { resolveVoice, listVoices } = require('../src/voices');
  assert.strictEqual(resolveVoice('edge').voice, 'he-IL-HilaNeural', 'legacy 1.0 engine name');
  assert.strictEqual(resolveVoice('he-IL-Chirp3-HD-Puck', { googleApiKey: 'k' }).engine, 'googlecloud');
  assert.ok(listVoices().filter((v) => v.gender === 'f').length >= 10 && listVoices().filter((v) => v.gender === 'm').length >= 10);

  // 7. pyatv env: installs into a private venv using a fake system python
  const { PyatvEnv } = require('../src/pyatv-env');
  const fakeSys = path.join(tmp, 'sys');
  fs.mkdirSync(path.join(fakeSys, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(fakeSys, 'bin', 'python3'), `#!/bin/sh
# python3 -m venv <dir>  → create <dir>/bin/python that is our fake helper python
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then mkdir -p "$3/bin"; cp ${JSON.stringify(fakePython)} "$3/bin/python"; exit 0; fi
exit 1
`);
  fs.chmodSync(path.join(fakeSys, 'bin', 'python3'), 0o755);
  const oldPath = process.env.PATH;
  const engine = new PyatvEnv(log, { baseDir: path.join(tmp, 'env') });
  engine.findSystemPython = async () => path.join(fakeSys, 'bin', 'python3');
  // pip calls go to the fake python, which fails on non-JSON args → make pip a no-op by wrapping
  const realHelper = engine.helper.bind(engine);
  const { execFile } = require('child_process');
  assert.strictEqual(engine.status(), 'missing');
  // patch: fake venv python treats "-m pip ..." as success
  fs.writeFileSync(fakePython + '-pipok', '');
  const origCp = fs.readFileSync(fakePython, 'utf8');
  fs.writeFileSync(fakePython, origCp.replace('const reply = (a) =>', "if (process.argv[2] === '-m') process.exit(0);\nconst reply = (a) =>"));
  await engine.ensure();
  assert.strictEqual(engine.status(), 'ready');
  await Promise.all([engine.ensure(), engine.ensure()]);
  process.env.PATH = oldPath;
  void realHelper; void execFile;

  // 7b. Gemini: real voices + styles, PCM → WAV, falls back to the older model on 404
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    if (url.includes('gemini-3.1')) return new Response('not found', { status: 404, statusText: 'Not Found' });
    const pcm = Buffer.alloc(4800, 7).toString('base64');
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm } }] } }] }), { status: 200 });
  };
  const realGemini = require('../src/tts').engines.gemini;
  const { TtsService } = require('../src/tts');
  const gsvc = new TtsService({ geminiApiKey: 'k' }, path.join(tmp, 'gcache'), log);
  const g1 = await gsvc.getAudio('שלום לכולם', 'gemini-puck', 'whisper');
  assert.strictEqual(g1.voice, 'gemini-puck');
  assert.ok(g1.file.endsWith('.wav'));
  const wav = fs.readFileSync(g1.file);
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.readUInt32LE(24), 24000);
  assert.strictEqual(seen.length, 2, 'tried 3.1 then 2.5');
  assert.ok(seen[1].body.contents[0].parts[0].text.startsWith('Whisper'), 'style sent as instruction');
  assert.strictEqual(seen[1].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
  const g2 = await gsvc.getAudio('שלום לכולם', 'gemini-puck', 'cheerful');
  assert.notStrictEqual(g2.file, g1.file, 'different style → different audio');
  global.fetch = realFetch;
  void realGemini;
  const { resolveVoice: rv } = require('../src/voices');
  assert.strictEqual(rv('elevenlabs', { elevenlabsVoiceId: 'x' }, 'whisper').tag, '[whispers]');
  assert.strictEqual(rv('hila', {}, 'excited').pitch, '+18Hz');

  // 7c. OpenAI, Cartesia (API-version fallback) and ElevenLabs voice cloning
  const calls2 = [];
  global.fetch = async (url, init) => {
    calls2.push({ url, init });
    if (url.includes('api.openai.com')) return new Response(Buffer.alloc(900, 1), { status: 200 });
    if (url.includes('cartesia') && init.headers['Cartesia-Version'] === '2026-08-14') {
      return new Response('{"error":"invalid Cartesia-Version"}', { status: 400, statusText: 'Bad Request' });
    }
    if (url.includes('cartesia.ai/tts')) return new Response(Buffer.alloc(900, 2), { status: 200 });
    if (url.includes('cartesia.ai/voices')) {
      return new Response(JSON.stringify({ data: [{ id: 'v1', name: 'Ayala', language: 'he', gender: 'feminine' }, { id: 'v2', name: 'Noam', language: 'he', gender: 'masculine' }, { id: 'v3', name: 'Bob', language: 'en' }], has_more: false }), { status: 200 });
    }
    if (url.includes('elevenlabs.io/v1/voices/add')) return new Response('{"voice_id":"CLONE123"}', { status: 200 });
    return new Response('nope', { status: 500 });
  };
  const osvc = new TtsService({ openaiApiKey: 'o', cartesiaApiKey: 'c' }, path.join(tmp, 'ocache'), log);
  const o1 = await osvc.getAudio('שלום', 'openai-onyx', 'urgent');
  assert.strictEqual(o1.voice, 'openai-onyx');
  const ob = JSON.parse(calls2[0].init.body);
  assert.strictEqual(ob.voice, 'onyx');
  assert.ok(ob.instructions.includes('urgently') && ob.instructions.includes('Israeli'));
  const c1 = await osvc.getAudio('שלום', 'cartesia:v1');
  assert.strictEqual(c1.voice, 'cartesia:v1');
  const cb = JSON.parse(calls2.find((c) => c.url.includes('tts/bytes') && c.init.headers['Cartesia-Version'] !== '2026-08-14').init.body);
  assert.strictEqual(cb.language, 'he');
  assert.strictEqual(cb.voice.id, 'v1');
  const { listCartesiaVoices, createElevenLabsClone } = require('../src/providers');
  const cv = await listCartesiaVoices('c');
  assert.deepStrictEqual(cv.map((v) => [v.name, v.gender]), [['Ayala', 'f'], ['Noam', 'm']]);
  const clone = await createElevenLabsClone('e', 'הקול של אורן', [{ name: 'a.m4a', type: 'audio/mp4', data: Buffer.alloc(5000, 3) }]);
  assert.strictEqual(clone.id, 'CLONE123');
  const cl = calls2.find((c) => c.url.includes('voices/add'));
  assert.ok(cl.init.body instanceof FormData && cl.init.body.get('name') === 'הקול של אורן');
  assert.strictEqual(rv('clone:CLONE123', { elevenlabsApiKey: 'e' }).voice, 'CLONE123');
  global.fetch = realFetch;

  // 8. switchName
  const { switchName } = require('../src/platform');
  assert.strictEqual(switchName('מזגן דולק וחלון פתוח בחדר של תומר, נא לסגור את החלון בבקשה'), 'מזגן דולק וחלון פתוח בחדר של תומר נא');

  // 8a. a voice without its API key falls back to Hila and says so
  {
    const { TtsService } = require('../src/tts');
    const t = new TtsService({}, path.join(tmp, 'fb-cache'), log);
    const a = await t.getAudio('בדיקת מפתח', 'openai-onyx');
    assert.strictEqual(a.voice, 'hila');
    assert.strictEqual(a.requested, 'openai-onyx');
    assert.ok(/key is missing/i.test(a.fallbackReason), a.fallbackReason);
    const b = await t.getAudio('בדיקת מפתח', 'openai-onyx'); // cached fallback still reports it
    assert.strictEqual(b.requested, 'openai-onyx');
    const c = await t.getAudio('בדיקת מפתח', 'hila');
    assert.strictEqual(c.requested, undefined);
  }

  // 8b. repeat guard: a burst of triggers on one switch speaks only once
  {
    const before = speakCalls().length;
    platform.lastTrigger.clear();
    const on = registered[1].getService('switch').getCharacteristic('On');
    for (let i = 0; i < 15; i++) on.setter(true);
    await sleep(600);
    const burst = speakCalls().slice(before);
    assert.strictEqual(burst.length, 1, `burst of 15 triggers played ${burst.length} times`);
    assert.ok(logs.some((l) => l.includes('triggered again while still playing')), 'repeat warning logged');
  }

  // 9. group mode: one accessory, a switch per phrase
  {
    const reg2 = [];
    let unreg = [];
    const api2 = Object.assign(new EventEmitter(), api, {
      registerPlatformAccessories: (p, n, a) => reg2.push(...a),
      unregisterPlatformAccessories: (p, n, a) => { unreg = a; },
    });
    const gp = new Platform(log, { ...config, webhook: {}, pregenerate: false, groupSwitches: true }, api2);
    for (const a of registered) gp.configureAccessory(a); // the old per-phrase switches are cached
    gp.speakers = platform.speakers; gp.tts = platform.tts; gp.engine = platform.engine;
    gp.syncAccessories();
    assert.strictEqual(reg2.length, 1, 'one group accessory');
    assert.strictEqual(reg2[0].displayName, 'קבצי הקול שלי');
    const sw = reg2[0].services.filter((x) => x.UUID === 'switch');
    assert.deepStrictEqual(sw.map((x) => x.subtype), ['ארוחת ערב מוכנה כולם לשולחן', 'הכביסה מוכנה', 'Good night']);
    assert.strictEqual(unreg.length, 3, 'old single switches removed');
    const before = speakCalls().length;
    sw[1].getCharacteristic('On').setter(true);
    await sleep(400);
    const last = speakCalls().slice(before);
    assert.ok(last.length >= 1 && last.every((c) => c.host === '10.0.0.5'), 'group switch speaks its own phrase on its HomePod');

    // more than 90 phrases continue in a second group
    const many = Array.from({ length: 95 }, (_, i) => `משפט מספר ${i + 1}`);
    gp.config = { ...gp.config, phrases: many };
    gp.syncAccessories();
    const groups = reg2.filter((a) => a.context.group && a.services.some((x) => x.UUID === 'switch'));
    assert.deepStrictEqual(groups.map((a) => a.displayName), ['קבצי הקול שלי', 'קבצי הקול שלי 2']);
    assert.strictEqual(groups[0].services.filter((x) => x.UUID === 'switch').length, 90);
    assert.strictEqual(groups[1].services.filter((x) => x.UUID === 'switch').length, 5);

    // a removed phrase disappears from the group; back to single switches removes the group
    gp.config = { ...gp.config, phrases: [config.phrases[1]] };
    gp.syncAccessories();
    assert.deepStrictEqual(reg2[0].services.filter((x) => x.UUID === 'switch').map((x) => x.subtype), ['הכביסה מוכנה']);
    gp.config = { ...gp.config, groupSwitches: false };
    gp.syncAccessories();
    assert.strictEqual(unreg[0], reg2[0], 'group accessory removed when grouping is off');
  }

  /* ---------- 1.6.0: urgent, quiet hours, chime, availability ---------- */
  {
    const { Speaker } = require('../src/player');
    const { quietNow } = require('../src/platform');
    // priority queue: urgent jumps ahead of waiting normal announcements and is never dropped
    const order = [];
    const fakeEngine = { ensure: async () => {}, helper: async (a) => { order.push(a.files[0]); await sleep(30); return { ok: true }; } };
    const sp = new Speaker({ name: 'x', volume: 60 }, fakeEngine, log);
    const jobs = ['n1', 'n2', 'n3', 'n4', 'n5'].map((f) => sp.play(f).catch(() => 'dropped'));
    const dropped = sp.play('n6').catch(() => 'dropped');
    const u = sp.play('u1', { urgent: true });
    await Promise.all([...jobs, u]);
    assert.strictEqual(await dropped, 'dropped', 'normal announcement dropped when the queue is full');
    assert.deepStrictEqual(order, ['n1', 'u1', 'n2', 'n3', 'n4', 'n5'], 'urgent plays right after the current one');
    // quiet-hours volume cap
    const caps = [];
    const capEngine = { ensure: async () => {}, helper: async (a) => { caps.push(a.volume); return { ok: true }; } };
    const sp2 = new Speaker({ name: 'y', volume: 60 }, capEngine, log);
    await sp2.play('a', { maxVolume: 20 });
    await sp2.play('a', { volume: 10, maxVolume: 20 });
    await sp2.play('a', {});
    assert.deepStrictEqual(caps, [20, 10, 60]);

    const at = (h, m) => new Date(2026, 0, 1, h, m);
    const qc = { quietHours: { enabled: true, start: '22:00', end: '07:00', volume: 15 } };
    assert.deepStrictEqual(quietNow(qc, at(23, 30)), { mute: false, volume: 15 });
    assert.deepStrictEqual(quietNow(qc, at(6, 59)), { mute: false, volume: 15 });
    assert.strictEqual(quietNow(qc, at(7, 0)), null);
    assert.strictEqual(quietNow(qc, at(12, 0)), null);
    assert.strictEqual(quietNow({ quietHours: { ...qc.quietHours, start: '13:00', end: '15:00' } }, at(14, 0)).volume, 15);
    assert.strictEqual(quietNow({ quietHours: { ...qc.quietHours, enabled: false } }, at(23, 0)), null);
    assert.strictEqual(quietNow({ quietHours: { ...qc.quietHours, mode: 'mute' } }, at(23, 0)).mute, true);

    // chime WAV + chime before the speech, urgent beeps for urgent phrases
    const { chimeFile } = require('../src/chime');
    const cf = chimeFile(path.join(tmp, 'chimes'), 'dingdong');
    assert.strictEqual(fs.readFileSync(cf).toString('ascii', 0, 4), 'RIFF');
    assert.strictEqual(chimeFile(tmp, 'nope'), null);

    const reg3 = [];
    const api3 = Object.assign(new EventEmitter(), {
      hap: api.hap, platformAccessory: api.platformAccessory, user: api.user, updatePlatformAccessories: () => {},
      registerPlatformAccessories: (p, n, a) => reg3.push(...a), unregisterPlatformAccessories: () => {},
    });
    const cp = new Platform(log, {
      ...config,
      webhook: { enabled: false },
      phrases: [{ text: 'רגיל', speakers: ['מטבח'] }, { text: 'אזעקה', speakers: ['מטבח'], urgent: true }],
      chime: { enabled: true, sound: 'dingdong' },
      quietHours: { enabled: true, start: '00:00', end: '23:59', mode: 'mute' },
      availability: { enabled: true, intervalMinutes: 5 },
    }, api3);
    api3.emit('didFinishLaunching');
    await sleep(600);
    const sensors = reg3.filter((a) => a.context.sensorFor);
    assert.deepStrictEqual(sensors.map((a) => a.displayName), ['מטבח מחובר', 'חדר שינה הורים מחובר', 'Broken מחובר']);
    assert.ok(calls().some((c) => c.cmd === 'ping'), 'availability checked at startup');
    const css = (a) => a.getService('contact').getCharacteristic(api.hap.Characteristic.ContactSensorState);
    assert.strictEqual(css(sensors[0]).getter(), 0, 'reachable HomePod → closed');
    assert.strictEqual(css(sensors[2]).getter(), 1, 'unreachable HomePod → open');

    const now = new Date();
    const muted = now.getHours() * 60 + now.getMinutes() < 23 * 60 + 59;
    fs.rmSync(callsLog, { force: true });
    const r1 = await cp.say('רגיל', { speakers: ['מטבח'] });
    if (muted) {
      assert.strictEqual(r1.quiet, 'muted');
      assert.strictEqual(speakCalls().length, 0, 'quiet hours (mute) → nothing played');
    }
    const r2 = await cp.say('אזעקה', { speakers: ['מטבח'], urgent: true });
    assert.ok(!r2.quiet, 'urgent ignores quiet hours');
    const last = speakCalls().pop();
    assert.ok(/chime-urgent/.test(last.files[0]) && last.files.length === 2, 'urgent beeps before the speech');
    cp.config = { ...cp.config, quietHours: { enabled: false } };
    await cp.say('רגיל', { speakers: ['מטבח'] });
    assert.ok(/chime-dingdong/.test(speakCalls().pop().files[0]), 'ding-dong before normal speech');
    cp.config = { ...cp.config, chime: { enabled: false } };
    await cp.say('רגיל', { speakers: ['מטבח'] });
    assert.strictEqual(speakCalls().pop().files.length, 1, 'no chime when disabled');
    api3.emit('shutdown');
  }

  api.emit('shutdown');
  console.log('All tests passed');
  console.log(logs.filter((l) => l.startsWith('E') || l.startsWith('W')).join('\n'));
  process.exit(0);
})().catch((e) => { console.error(e); console.error(logs.join('\n')); process.exit(1); });
