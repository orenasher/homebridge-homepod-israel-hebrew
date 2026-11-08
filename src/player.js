'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CANDIDATES = [
  '/opt/pyatv/bin/atvremote',
  '/usr/local/bin/atvremote',
  '/usr/bin/atvremote',
  path.join(os.homedir(), '.local/bin/atvremote'),
  '/var/lib/homebridge/.local/bin/atvremote',
  '/home/pi/.local/bin/atvremote',
];

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || '').toString().trim().split('\n').slice(-3).join(' ');
        const msg = err.killed ? `timed out after ${timeoutMs} ms` : (detail || err.message);
        reject(new Error(msg));
      } else {
        resolve(String(stdout).trim());
      }
    });
  });
}

/** Locate the atvremote binary from pyatv. Returns null if missing. */
function findAtvremote(configured) {
  const list = configured ? [configured, ...CANDIDATES] : CANDIDATES;
  for (const p of list) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* next */ }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, 'atvremote');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* next */ }
  }
  return null;
}

class Speaker {
  /**
   * @param {object} cfg {name, id, host, credentials, volume}
   * @param {string} bin path to atvremote
   * @param {object} log
   */
  constructor(cfg, bin, log) {
    this.name = cfg.name;
    this.id = cfg.id || '';
    this.host = cfg.host || '';
    this.credentials = cfg.credentials || '';
    this.defaultVolume = numberOrNull(cfg.volume);
    this.bin = bin;
    this.log = log;
    this.queue = Promise.resolve();
  }

  baseArgs() {
    const args = [];
    if (this.host) args.push('-s', this.host);
    if (this.id) args.push('--id', this.id);
    else args.push('-n', this.name);
    if (this.credentials) args.push('--raop-credentials', this.credentials);
    return args;
  }

  async getVolume() {
    const out = await run(this.bin, [...this.baseArgs(), 'volume'], 15000);
    const v = parseFloat(out.split('\n').pop());
    return Number.isFinite(v) ? v : null;
  }

  async setVolume(v) {
    await run(this.bin, [...this.baseArgs(), `set_volume=${clamp(v)}`], 15000);
  }

  /** Queue an announcement so two announcements never talk over each other on one speaker. */
  play(file, opts = {}) {
    const job = this.queue.then(() => this._play(file, opts));
    this.queue = job.catch(() => {});
    return job;
  }

  async _play(file, { volume, restoreVolume = true } = {}) {
    const target = numberOrNull(volume) ?? this.defaultVolume;
    let previous = null;
    if (target !== null) {
      if (restoreVolume) {
        try {
          previous = await this.getVolume();
        } catch (err) {
          this.log.debug(`[${this.name}] could not read volume: ${err.message}`);
        }
      }
      try {
        await this.setVolume(target);
      } catch (err) {
        this.log.warn(`[${this.name}] could not set volume: ${err.message}`);
      }
    }
    try {
      await run(this.bin, [...this.baseArgs(), `stream_file=${file}`], 180000);
    } finally {
      if (previous !== null && previous !== target) {
        try {
          await this.setVolume(previous);
        } catch (err) {
          this.log.debug(`[${this.name}] could not restore volume: ${err.message}`);
        }
      }
    }
  }
}

function numberOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n) : null;
}

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(Number(v))));
}

module.exports = { Speaker, findAtvremote, run };
