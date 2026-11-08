#!/usr/bin/env node
'use strict';

/*
 * Command-line helper (run as the homebridge user):
 *   node cli.js engine                      install / check the voice engine
 *   node cli.js scan                        list HomePods on the network
 *   node cli.js say "טקסט" [name,name] [voice]  speak using the speakers from config.json
 * Options: --config /var/lib/homebridge/config.json
 */

const fs = require('fs');
const path = require('path');
const { PyatvEnv } = require('./pyatv-env');
const { TtsService } = require('./tts');
const { Speaker } = require('./player');
const { CACHE_DIR } = require('./platform');

const log = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };

function loadConfig(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (cfg.platforms || []).find((p) => p.platform === 'HomePodIsraelHebrew') || {};
}

(async () => {
  const args = process.argv.slice(2);
  const ci = args.indexOf('--config');
  const configFile = ci >= 0 ? args.splice(ci, 2)[1] : '/var/lib/homebridge/config.json';
  const [cmd, ...rest] = args;
  const env = new PyatvEnv(log, { storagePath: path.dirname(path.resolve(configFile)) });
  env.noDaemon = true; // one-shot is simpler for a command that exits right away

  if (cmd === 'engine') {
    await env.ensure();
    console.log('OK — voice engine ready');
  } else if (cmd === 'scan') {
    await env.ensure();
    const { devices } = await env.helper({ cmd: 'scan', timeout: 6 }, 60000);
    for (const d of devices) {
      console.log(`${d.homepod ? '🔊' : '  '} ${d.name}  ${d.host}  ${d.id}  ${d.model}${d.needsPairing ? '  (needs pairing — not supported)' : ''}`);
    }
  } else if (cmd === 'say') {
    const [text, names, voice, style] = rest;
    if (!text) throw new Error('usage: say "text" [speaker,speaker] [voice] [style]');
    const cfg = loadConfig(configFile);
    const wanted = names ? names.split(',').map((s) => s.trim()) : [];
    const speakers = (cfg.speakers || []).filter((s) => !wanted.length || wanted.includes(s.name));
    if (!speakers.length) throw new Error('no HomePods configured in config.json');
    const tts = new TtsService(cfg.tts || {}, path.join(path.dirname(configFile), CACHE_DIR), log);
    const audio = await tts.getAudio(text, voice || cfg.voice, style || cfg.style);
    console.log(`voice: ${audio.voice}${audio.cached ? ' (cached)' : ''}`);
    await env.ensure();
    const results = await Promise.allSettled(speakers.map((s) => new Speaker(s, env, log).play(audio.file)));
    results.forEach((r, i) => console.log(`${speakers[i].name}: ${r.status === 'fulfilled' ? 'OK ✓' : `FAILED — ${r.reason.message}`}`));
  }
  if (!cmd || !['engine', 'scan', 'say'].includes(cmd)) {
    console.log('commands: engine | scan | say "text" [speakers] [voice]   (--config <path>)');
  }
})().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
