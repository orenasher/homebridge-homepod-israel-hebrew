'use strict';

const MAX_QUEUE = 5; // never let a burst of normal triggers pile up on one HomePod

class Speaker {
  /**
   * @param {object} cfg {name, id, host, volume}
   * @param {import('./pyatv-env').PyatvEnv} engine
   * @param {object} log
   */
  constructor(cfg, engine, log) {
    this.name = cfg.name;
    this.id = cfg.id || '';
    this.host = cfg.host || '';
    this.defaultVolume = numberOrNull(cfg.volume);
    this.engine = engine;
    this.log = log;
    this.jobs = [];      // waiting announcements; urgent ones are kept at the front
    this.running = false;
    this.onResult = null; // (ok: boolean) => void — used by the availability sensor
  }

  /** Announcements waiting or playing on this HomePod. */
  get pending() {
    return this.jobs.length + (this.running ? 1 : 0);
  }

  /**
   * Queue an announcement so two announcements never talk over each other on one speaker.
   * Urgent announcements skip ahead of normal ones and are never dropped.
   * @param {string|string[]} files audio file(s), played back to back
   */
  play(files, opts = {}) {
    const urgent = !!opts.urgent;
    if (!urgent && this.pending >= MAX_QUEUE) {
      return Promise.reject(new Error(`${this.name}: ${this.pending} announcements already waiting — skipped`));
    }
    return new Promise((resolve, reject) => {
      const job = { files: [].concat(files), opts, urgent, resolve, reject };
      if (urgent) {
        const firstNormal = this.jobs.findIndex((j) => !j.urgent);
        this.jobs.splice(firstNormal < 0 ? this.jobs.length : firstNormal, 0, job);
      } else {
        this.jobs.push(job);
      }
      this._next();
    });
  }

  _next() {
    if (this.running || !this.jobs.length) return;
    const job = this.jobs.shift();
    this.running = true;
    this._play(job.files, job.opts)
      .then((r) => { this._report(true); job.resolve(r); },
        (err) => { this._report(false); job.reject(err); })
      .finally(() => {
        this.running = false;
        this._next();
      });
  }

  _report(ok) {
    if (this.onResult) {
      try { this.onResult(ok); } catch { /* ignore */ }
    }
  }

  async _play(files, { volume, maxVolume, restoreVolume = true } = {}) {
    await this.engine.ensure();
    let target = numberOrNull(volume) ?? this.defaultVolume;
    const cap = numberOrNull(maxVolume);
    if (cap !== null) target = target === null ? cap : Math.min(target, cap);
    const reply = await this.engine.helper({
      cmd: 'speak', host: this.host, id: this.id, files, volume: target, restore: restoreVolume,
    });
    for (const w of reply.warnings || []) this.log.debug(`[${this.name}] ${w}`);
    return reply;
  }

  /** Is the HomePod reachable on the network right now? */
  async ping() {
    await this.engine.ensure();
    const reply = await this.engine.helper({ cmd: 'ping', host: this.host, id: this.id }, 30000);
    return !!reply.online;
  }
}

function numberOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

module.exports = { Speaker, numberOrNull, MAX_QUEUE };
