'use strict';
// Offline test: mocks Homebridge, the TTS engines and atvremote.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hps-'));
const callsLog = path.join(tmp, 'calls.log');
const fakeBin = path.join(tmp, 'atvremote');
fs.writeFileSync(fakeBin, `#!/bin/sh
echo "$@" >> "${callsLog}"
case "$*" in *" volume"|*"volume") echo "35.0";; esac
case "$*" in *Broken*) echo "Could not find any device" >&2; exit 1;; esac
exit 0
`);
fs.chmodSync(fakeBin, 0o755);

const tts = require('../src/tts');
let edgeFail = false;
const generated = [];
tts.engines.edge = async (text, opts, out) => {
  if (edgeFail) throw new Error('edge down');
  generated.push(['edge', opts.voice, text]);
  fs.writeFileSync(out, Buffer.alloc(1000, 1));
};
tts.engines.googletranslate = async (text, opts, out) => {
  generated.push(['googletranslate', text]);
  fs.writeFileSync(out, Buffer.alloc(1000, 2));
};
tts.engines.elevenlabs = async () => { throw new Error('401 bad key'); };

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
  getCharacteristic(c) { if (!this.chars.has(c)) this.chars.set(c, new Characteristic()); return this.chars.get(c); }
}
const Svc = { AccessoryInformation: 'info', Switch: 'switch' };
class PlatformAccessory {
  constructor(name, uuid) { this.displayName = name; this.UUID = uuid; this.context = {}; this.services = { info: new Service('info') }; }
  getService(t) { return this.services[t]; }
  addService(t, n) { this.services[t] = new Service(n); return this.services[t]; }
}
const api = new EventEmitter();
api.hap = { Service: Svc, Characteristic: { On: 'On', Name: 'Name', Manufacturer: 'm', Model: 'mo', SerialNumber: 's' },
  uuid: { generate: (s) => require('crypto').createHash('md5').update(s).digest('hex') } };
api.platformAccessory = PlatformAccessory;
api.user = { storagePath: () => tmp };
const registered = [];
api.registerPlatformAccessories = (p, n, a) => registered.push(...a);
api.updatePlatformAccessories = () => {};
api.unregisterPlatformAccessories = () => {};
const logs = [];
const log = Object.assign((...a) => logs.push(a.join(' ')), {
  info: (m) => logs.push('I ' + m), warn: (m) => logs.push('W ' + m), error: (m) => logs.push('E ' + m), debug: () => {},
});

let registerFn;
require('../index')({ registerPlatform: (plugin, name, cls) => { registerFn = cls; } });

const config = {
  platform: 'HomePodIsraelHebrew',
  atvremotePath: fakeBin,
  speakers: [{ name: 'Kitchen', id: 'AA:BB', host: '10.0.0.5', volume: 40 }, { name: 'Bedroom', id: 'CC:DD' }, { name: 'Broken' }],
  announcements: [
    { name: 'Laundry', text: 'הכביסה מוכנה', speakers: ['Kitchen'], volume: 70 },
    { name: 'Dinner', text: 'ארוחת ערב!' },
  ],
  tts: { engine: 'edge', edgeVoice: 'he-IL-AvriNeural' },
  webhook: { enabled: true, port: 18095, token: 'secret' },
};

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: 18095, path: p, method, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = () => (fs.existsSync(callsLog) ? fs.readFileSync(callsLog, 'utf8').trim().split('\n') : []);

(async () => {
  const platform = new registerFn(log, config, api);
  api.emit('didFinishLaunching');
  await sleep(300);

  assert.strictEqual(registered.length, 2, 'two switches registered');
  assert.ok(generated.some((g) => g[1] === 'he-IL-AvriNeural'), 'pregenerated with configured voice');
  const before = generated.length;

  // 1. Switch trigger → volume read, set 70, stream, restore 35
  fs.rmSync(callsLog, { force: true });
  const laundry = registered.find((a) => a.displayName === 'Laundry');
  const on = laundry.getService('switch').getCharacteristic('On');
  on.setter(true);
  await sleep(300);
  const c1 = calls();
  assert.deepStrictEqual(c1.map((l) => l.split(' ').pop().split('=')[0]), ['volume', 'set_volume', 'stream_file', 'set_volume']);
  assert.ok(c1[0].startsWith('-s 10.0.0.5 --id AA:BB'), 'uses host and id');
  assert.ok(c1[1].endsWith('set_volume=70') && c1[3].endsWith('set_volume=35'), 'sets then restores volume');
  assert.strictEqual(generated.length, before, 'cached audio reused, no regeneration');
  await sleep(900);
  assert.strictEqual(on.value, false, 'switch resets to off');

  // 2. Webhook auth
  let r = await req('GET', '/say?text=hi');
  assert.strictEqual(r.status, 401);

  // 3. Webhook dynamic text to two speakers, Hebrew via POST JSON
  fs.rmSync(callsLog, { force: true });
  r = await req('POST', '/say', JSON.stringify({ text: 'שלום לכולם', speakers: 'Kitchen,Bedroom' }),
    { 'Content-Type': 'application/json', Authorization: 'Bearer secret' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.deepStrictEqual(r.json.speakers, ['Kitchen', 'Bedroom']);
  assert.ok(calls().some((l) => l.startsWith('--id CC:DD') && l.includes('stream_file=')), 'bedroom played via id');

  // 4. Partial failure: one broken speaker doesn't fail the whole call
  r = await req('GET', '/say?token=secret&speakers=all&text=' + encodeURIComponent('בדיקה'));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.failed, ['Broken']);

  // 5. Announce by name, wait=0
  r = await req('GET', '/announce?token=secret&wait=0&name=dinner');
  assert.strictEqual(r.status, 202);
  r = await req('GET', '/announce?token=secret&name=nope');
  assert.strictEqual(r.status, 404);

  // 6. Fallback: primary elevenlabs fails, edge fails → googletranslate
  edgeFail = true;
  const a = await platform.tts.getAudio('טקסט חדש', { engine: 'elevenlabs' });
  assert.strictEqual(a.engine, 'googletranslate');
  edgeFail = false;
  // next time edge works again → uses edge (better voice), not the cached fallback
  const b = await platform.tts.getAudio('טקסט חדש', { engine: 'edge' });
  assert.strictEqual(b.engine, 'edge');

  // 7. status
  r = await req('GET', '/status?token=secret');
  assert.deepStrictEqual(r.json.announcements, ['Laundry', 'Dinner']);

  // 8. splitText
  const parts = tts.splitText('מילה '.repeat(100), 180);
  assert.ok(parts.every((p) => p.length <= 180) && parts.join(' ').split(' ').length === 100);

  api.emit('shutdown');
  console.log('All tests passed');
  console.log(logs.filter((l) => l.startsWith('E') || l.startsWith('W')).join('\n'));
  process.exit(0);
})().catch((e) => { console.error(e); console.error(logs.join('\n')); process.exit(1); });
