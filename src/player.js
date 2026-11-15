'use strict';

const MAX_QUEUE = 10; // a runaway automation loop is stopped by the repeat guard; this is a last safety net
const CHIME_GAP_MS = 4000; // announcements that follow each other closely share one chime

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
    this.lastEnd = 0;
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
    // Announcements that arrived together (several windows opened at once…) are played back to back
    // on one connection: no gap between them, one chime, and nobody is left out.
    const batch = [this.jobs.shift()];
    const key = this._volumeKey(batch[0].opts);
    while (this.jobs.length && batch.length < MAX_QUEUE && this._volumeKey(this.jobs[0].opts) === key) {
      batch.push(this.jobs.shift());
    }
    const files = [];
    const chime = batch.map((j) => j.opts.chime).find(Boolean);
    if (chime && Date.now() - this.lastEnd > CHIME_GAP_MS) files.push(chime);
    for (const j of batch) files.push(...j.files);

    this.running = true;
    this._play(files, batch[0].opts)
      .then((r) => { this._report(true); batch.forEach((j) => j.resolve(r)); },
        (err) => { this._report(false); batch.forEach((j) => j.reject(err)); })
      .finally(() => {
        this.running = false;
        this.lastEnd = Date.now();
        this._next();
      });
  }

  /** Jobs can share one playback only if they would play at the same volume. */
  _volumeKey(opts = {}) {
    return `${numberOrNull(opts.volume) ?? 'd'}|${numberOrNull(opts.maxVolume) ?? '-'}|${opts.restoreVolume !== false}`;
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
