'use strict';

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
  }

  /** Queue an announcement so two announcements never talk over each other on one speaker. */
  play(file, opts = {}) {
    const job = this.queue.then(() => this._play(file, opts));
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
