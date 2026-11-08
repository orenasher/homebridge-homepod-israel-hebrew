#!/usr/bin/env node
'use strict';

/*
 * Adds (or updates) the HomePod Israel Hebrew platform in Homebridge's config.json.
 *   node setup-config.js <config.json> '<json with speakers/phrases/...>'
 * Keeps a backup next to the file. Existing phrases are kept unless new ones are given.
 */

const fs = require('fs');

const [file, json] = process.argv.slice(2);
if (!file || !json) {
  console.error('usage: setup-config.js <config.json> <json>');
  process.exit(2);
}
const patch = JSON.parse(json);
const raw = fs.readFileSync(file, 'utf8');
const cfg = JSON.parse(raw);
const backup = `${file}.before-homepod-${Date.now()}`;
fs.writeFileSync(backup, raw);

cfg.platforms = cfg.platforms || [];
let block = cfg.platforms.find((p) => p.platform === 'HomePodIsraelHebrew');
if (!block) {
  block = { platform: 'HomePodIsraelHebrew', name: 'HomePod Israel Hebrew' };
  cfg.platforms.push(block);
}
Object.assign(block, { language: 'he', voice: 'hila', ...block, ...patch });
fs.writeFileSync(file, `${JSON.stringify(cfg, null, 4)}\n`);
console.log(`OK — HomePod Israel Hebrew configured (${(block.speakers || []).length} HomePods, ${(block.phrases || []).length} phrases). Backup: ${backup}`);
