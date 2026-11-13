'use strict';

const MAX_QUEUE = 5; // never let a burst of triggers pile up on one HomePod

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
    this.queue = Promise.resolve();
    this.pending = 0;
  }

  /** Queue an announcement so two announcements never talk over each other on one speaker. */
  play(file, opts = {}) {
    if (this.pending >= MAX_QUEUE) {
      return Promise.reject(new Error(`${this.name}: ${this.pending} announcements already waiting — skipped`));
    }
    this.pending += 1;
    const job = this.queue.then(() => this._play(file, opts)).finally(() => { this.pending -= 1; });
    this.queue = job.catch(() => {});
    return job;
  }

  async _play(file, { volume, restoreVolume = true } = {}) {
    await this.engine.ensure();
    const target = numberOrNull(volume) ?? this.defaultVolume;
    const reply = await this.engine.helper({
      cmd: 'speak', host: this.host, id: this.id, file, volume: target, restore: restoreVolume,
    });
    for (const w of reply.warnings || []) this.log.debug(`[${this.name}] ${w}`);
    return reply;
  }
}

function numberOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

module.exports = { Speaker, numberOrNull };
