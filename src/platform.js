'use strict';

const path = require('path');
const { TtsService } = require('./tts');
const { Speaker, findAtvremote } = require('./player');
const { startWebhook } = require('./webhook');

const PLUGIN_NAME = 'homebridge-homepod-israel-hebrew';
const PLATFORM_NAME = 'HomePodIsraelHebrew';

class HomePodIsraelHebrewPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map();
    this.speakers = new Map();
    this.server = null;

    if (!config) {
      log.warn('No configuration found — plugin disabled.');
      return;
    }

    api.on('didFinishLaunching', () => {
      this.setup().catch((err) => this.log.error(`Startup failed: ${err.stack || err.message}`));
    });
    api.on('shutdown', () => {
      if (this.server) this.server.close();
    });
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  async setup() {
    const cfg = this.config;
    this.tts = new TtsService(cfg.tts || {}, path.join(this.api.user.storagePath(), 'homepod-israel-hebrew-cache'), this.log);

    this.bin = findAtvremote(cfg.atvremotePath);
    if (!this.bin) {
      this.log.error('pyatv (atvremote) was not found, so nothing can be played yet.');
      this.log.error('Install it once from the Homebridge terminal:');
      this.log.error('  sudo apt install -y python3-venv && sudo python3 -m venv /opt/pyatv && sudo /opt/pyatv/bin/pip install pyatv');
      this.log.error('Then restart Homebridge. See the README for details.');
    } else {
      this.log.info(`Using ${this.bin}`);
    }

    for (const s of cfg.speakers || []) {
      if (!s || !s.name) continue;
      this.speakers.set(s.name, new Speaker(s, this.bin, this.log));
    }
    if (!this.speakers.size) this.log.warn('No speakers configured — add at least one HomePod in the settings.');

    this.syncAccessories();

    if (cfg.webhook && cfg.webhook.enabled) {
      this.server = startWebhook(this, cfg.webhook, this.log);
    }

    if (cfg.pregenerate !== false) this.pregenerate();
    this.tts.prune(cfg.cacheDays || 90).catch(() => {});
  }

  /* ------------------------------------------------------------ accessories */

  syncAccessories() {
    const { Service, Characteristic } = this.api.hap;
    const wanted = new Set();

    for (const item of this.config.announcements || []) {
      if (!item || !item.name || !item.text) continue;
      const uuid = this.api.hap.uuid.generate(`${PLATFORM_NAME}:${item.name}`);
      if (wanted.has(uuid)) {
        this.log.warn(`Duplicate announcement name "${item.name}" — skipped.`);
        continue;
      }
      wanted.add(uuid);

      let accessory = this.cached.get(uuid);
      const isNew = !accessory;
      if (isNew) {
        accessory = new this.api.platformAccessory(item.name, uuid);
      }
      accessory.context.item = item;

      accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, 'Oren Asher')
        .setCharacteristic(Characteristic.Model, 'HomePod Israel Hebrew')
        .setCharacteristic(Characteristic.SerialNumber, uuid.slice(0, 13));

      const service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, item.name);
      service.setCharacteristic(Characteristic.Name, item.name);
      const on = service.getCharacteristic(Characteristic.On);
      on.removeAllListeners('set');
      on.removeAllListeners('get');
      on.onGet(() => false);
      on.onSet((value) => {
        if (!value) return;
        // momentary: report "off" again shortly so the next trigger works
        setTimeout(() => on.updateValue(false), 1000);
        this.announce(accessory.context.item).catch((err) => this.log.error(`"${item.name}": ${err.message}`));
      });
      on.updateValue(false);

      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added "${item.name}"`);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    const stale = [...this.cached.values()].filter((a) => !wanted.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const a of stale) {
        this.cached.delete(a.UUID);
        this.log.info(`Removed "${a.displayName}"`);
      }
    }
  }

  /* ------------------------------------------------------------ speaking */

  resolveSpeakers(names) {
    const list = Array.isArray(names) ? names : (names ? String(names).split(',') : []);
    const clean = list.map((n) => String(n).trim()).filter(Boolean);
    if (!clean.length || clean.some((n) => n.toLowerCase() === 'all')) return [...this.speakers.values()];
    const found = [];
    for (const n of clean) {
      const s = this.speakers.get(n)
        || [...this.speakers.values()].find((x) => x.name.toLowerCase() === n.toLowerCase());
      if (s) found.push(s);
      else this.log.warn(`Unknown speaker "${n}"`);
    }
    return found;
  }

  /** Configured announcement (from a switch or the webhook). */
  announce(item) {
    return this.say(item.text, {
      speakers: item.speakers,
      volume: item.volume,
      engine: item.engine,
      voice: item.voice,
      label: item.name,
    });
  }

  /**
   * Say any text.
   * @returns {Promise<{engine: string, cached: boolean, speakers: string[]}>}
   */
  async say(text, { speakers, volume, engine, voice, label } = {}) {
    if (!this.bin) throw new Error('pyatv (atvremote) is not installed — see the log at startup');
    const targets = this.resolveSpeakers(speakers);
    if (!targets.length) throw new Error('no matching speakers');

    const started = Date.now();
    const audio = await this.tts.getAudio(text, { engine, voice });
    const tag = label ? `"${label}"` : `"${String(text).slice(0, 40)}"`;
    this.log.info(`Speaking ${tag} on ${targets.map((s) => s.name).join(', ')} `
      + `(${audio.engine}${audio.cached ? ', cached' : ''}, ready in ${Date.now() - started} ms)`);

    const restore = this.config.restoreVolume !== false;
    const results = await Promise.allSettled(targets.map((s) => s.play(audio.file, { volume, restoreVolume: restore })));
    const failed = [];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        failed.push(targets[i].name);
        this.log.error(`[${targets[i].name}] playback failed: ${r.reason.message}`);
      }
    });
    if (failed.length === targets.length) throw new Error(`playback failed on ${failed.join(', ')}`);
    return { engine: audio.engine, cached: audio.cached, speakers: targets.map((s) => s.name), failed };
  }

  /** Create audio for all configured phrases in the background so the first trigger is instant. */
  async pregenerate() {
    for (const item of this.config.announcements || []) {
      if (!item || !item.text) continue;
      try {
        const a = await this.tts.getAudio(item.text, { engine: item.engine, voice: item.voice });
        if (!a.cached) this.log.info(`Prepared audio for "${item.name}" (${a.engine})`);
      } catch (err) {
        this.log.warn(`Could not prepare "${item.name}": ${err.message}`);
      }
    }
  }
}

module.exports = { HomePodIsraelHebrewPlatform, PLUGIN_NAME, PLATFORM_NAME };
