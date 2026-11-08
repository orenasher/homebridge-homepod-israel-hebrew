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
  constructor(name) { this.name = name; this.chars = new Map(); }
  setCharacteristic() { return this; }
  testCharacteristic() { return false; }
  addOptionalCharacteristic() {}
  getCharacteristic(c) { if (!this.chars.has(c)) this.chars.set(c, new Characteristic()); return this.chars.get(c); }
}
class PlatformAccessory {
  constructor(name, uuid) { this.displayName = name; this.UUID = uuid; this.context = {}; this.services = { info: new Service('info') }; }
  getService(t) { return this.services[t]; }
  addService(t, n) { this.services[t] = new Service(n); return this.services[t]; }
}
const api = new EventEmitter();
api.hap = { Service: { AccessoryInformation: 'info', Switch: 'switch' },
  Characteristic: { On: 'On', Name: 'Name', ConfiguredName: 'CN', Manufacturer: 'm', Model: 'mo', SerialNumber: 's' },
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

  assert.strictEqual(platform.env.daemon && platform.env.daemon.alive, true, 'fast-mode helper is running');
  const pidBefore = platform.env.daemon.child.pid;

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

  assert.strictEqual(platform.env.daemon.child.pid, pidBefore, 'same helper process reused');
  // helper crash → next announcement restarts it transparently
  platform.env.daemon.child.kill();
  await sleep(200);
  const rr = await platform.say('אחרי קריסה', { speakers: 'מטבח' });
  assert.deepStrictEqual(rr.failed, []);
  assert.notStrictEqual(platform.env.daemon.child.pid, pidBefore, 'helper restarted');

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
  const env = new PyatvEnv(log, { baseDir: path.join(tmp, 'env') });
  env.findSystemPython = async () => path.join(fakeSys, 'bin', 'python3');
  // pip calls go to the fake python, which fails on non-JSON args → make pip a no-op by wrapping
  const realHelper = env.helper.bind(env);
  const { execFile } = require('child_process');
  assert.strictEqual(env.status(), 'missing');
  // patch: fake venv python treats "-m pip ..." as success
  fs.writeFileSync(fakePython + '-pipok', '');
  const origCp = fs.readFileSync(fakePython, 'utf8');
  fs.writeFileSync(fakePython, origCp.replace('const reply = (a) =>', "if (process.argv[2] === '-m') process.exit(0);\nconst reply = (a) =>"));
  await env.ensure();
  assert.strictEqual(env.status(), 'ready');
  await Promise.all([env.ensure(), env.ensure()]);
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

  // 8. switchName
  const { switchName } = require('../src/platform');
  assert.strictEqual(switchName('מזגן דולק וחלון פתוח בחדר של תומר, נא לסגור את החלון בבקשה'), 'מזגן דולק וחלון פתוח בחדר של תומר נא');

  api.emit('shutdown');
  console.log('All tests passed');
  console.log(logs.filter((l) => l.startsWith('E') || l.startsWith('W')).join('\n'));
  process.exit(0);
})().catch((e) => { console.error(e); console.error(logs.join('\n')); process.exit(1); });
