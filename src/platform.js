'use strict';

const path = require('path');
const { TtsService } = require('./tts');
const { Speaker } = require('./player');
const { PyatvEnv } = require('./pyatv-env');
const { startWebhook } = require('./webhook');
const { DEFAULT_VOICE } = require('./voices');

const PLUGIN_NAME = 'homebridge-homepod-israel-hebrew';
const PLATFORM_NAME = 'HomePodIsraelHebrew';
const CACHE_DIR = 'homepod-israel-hebrew-cache';

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

  get defaultVoice() {
    const c = this.config;
    return c.voice || (c.tts && c.tts.engine) || DEFAULT_VOICE;
  }

  async setup() {
    const cfg = this.config;
    this.tts = new TtsService(cfg.tts || {}, path.join(this.api.user.storagePath(), CACHE_DIR), this.log);
    this.env = new PyatvEnv(this.log, { pythonPath: cfg.pythonPath });

    for (const s of cfg.speakers || []) {
      if (!s || !s.name) continue;
      this.speakers.set(s.name, new Speaker(s, this.env, this.log));
    }
    if (!this.speakers.size) this.log.warn('No HomePods configured yet — open the plugin settings and tap "Find HomePods".');

    this.syncAccessories();

    if (cfg.webhook && cfg.webhook.enabled) {
      this.server = startWebhook(this, cfg.webhook, this.log);
    }

    // Prepare the voice engine and audio in the background.
    this.env.ensure().catch((err) => this.log.error(`Voice engine setup failed: ${err.message}`));
    if (cfg.pregenerate !== false) this.pregenerate();
    this.tts.prune(cfg.cacheDays || 90).catch(() => {});
  }

  /* ------------------------------------------------------------ phrases */

  /** All phrases: from "phrases" (strings or objects) plus legacy 1.0 "announcements". */
  items() {
    const list = [];
    const seen = new Set();
    const add = (raw) => {
      const p = typeof raw === 'string' ? { text: raw } : (raw || {});
      const text = String(p.text || '').trim();
      if (!text || p.enabled === false) return;
      const name = switchName(p.name || text);
      if (seen.has(name)) {
        this.log.warn(`Two phrases share the switch name "${name}" — the second one was skipped. Give it a different name.`);
        return;
      }
      seen.add(name);
      list.push({ ...p, text, name });
    };
    (this.config.phrases || []).forEach(add);
    (this.config.announcements || []).forEach(add);
    return list;
  }

  syncAccessories() {
    const { Service, Characteristic } = this.api.hap;
    const wanted = new Set();

    for (const item of this.items()) {
      const uuid = this.api.hap.uuid.generate(`${PLATFORM_NAME}:${item.name}`);
      wanted.add(uuid);

      let accessory = this.cached.get(uuid);
      const isNew = !accessory;
      if (isNew) accessory = new this.api.platformAccessory(item.name, uuid);
      accessory.context.item = item;

      accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, 'Oren Asher')
        .setCharacteristic(Characteristic.Model, 'HomePod Israel Hebrew')
        .setCharacteristic(Characteristic.SerialNumber, uuid.slice(0, 13));

      const service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, item.name);
      service.setCharacteristic(Characteristic.Name, item.name);
      if (Characteristic.ConfiguredName) {
        try {
          if (!service.testCharacteristic(Characteristic.ConfiguredName)) service.addOptionalCharacteristic(Characteristic.ConfiguredName);
          service.setCharacteristic(Characteristic.ConfiguredName, item.name);
        } catch { /* older HAP */ }
      }
      const on = service.getCharacteristic(Characteristic.On);
      on.onGet(() => false);
      on.onSet((value) => {
        if (!value) return;
        // momentary: report "off" again so the next trigger works
        setTimeout(() => on.updateValue(false), 1000);
        this.announce(accessory.context.item).catch((err) => this.log.error(`"${accessory.context.item.name}": ${err.message}`));
      });
      on.updateValue(false);

      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added switch "${item.name}"`);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    const stale = [...this.cached.values()].filter((a) => !wanted.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const a of stale) {
        this.cached.delete(a.UUID);
        this.log.info(`Removed switch "${a.displayName}"`);
      }
    }
  }

  /* ------------------------------------------------------------ speaking */

  resolveSpeakers(names) {
    const list = Array.isArray(names) ? names : (names ? String(names).split(',') : []);
    const clean = list.map((n) => String(n).trim()).filter(Boolean);
    if (!clean.length || clean.some((n) => ['all', 'הכל', 'כולם'].includes(n.toLowerCase()))) return [...this.speakers.values()];
    const found = [];
    for (const n of clean) {
      const s = this.speakers.get(n)
        || [...this.speakers.values()].find((x) => x.name.toLowerCase() === n.toLowerCase());
      if (s && !found.includes(s)) found.push(s);
      else if (!s) this.log.warn(`Unknown HomePod "${n}"`);
    }
    return found;
  }

  /** A configured phrase (from a switch or the webhook). */
  announce(item) {
    return this.say(item.text, { speakers: item.speakers, volume: item.volume, voice: item.voice, label: item.name });
  }

  /**
   * Say any text.
   * @returns {Promise<{voice: string, cached: boolean, speakers: string[], failed: string[]}>}
   */
  async say(text, { speakers, volume, voice, label } = {}) {
    const targets = this.resolveSpeakers(speakers);
    if (!targets.length) throw new Error('no matching HomePods');

    const started = Date.now();
    const audio = await this.tts.getAudio(text, voice || this.defaultVoice);
    const tag = label ? `"${label}"` : `"${String(text).slice(0, 40)}"`;
    this.log.info(`Speaking ${tag} on ${targets.map((s) => s.name).join(' + ')} `
      + `(${audio.voice}${audio.cached ? ', cached' : ''}, ready in ${Date.now() - started} ms)`);

    const restore = this.config.restoreVolume !== false;
    const results = await Promise.allSettled(targets.map((s) => s.play(audio.file, { volume, restoreVolume: restore })));
    const failed = [];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        failed.push(targets[i].name);
        this.log.error(`[${targets[i].name}] ${r.reason.message}`);
      }
    });
    if (failed.length === targets.length) throw new Error(`playback failed on ${failed.join(', ')}`);
    return { voice: audio.voice, cached: audio.cached, speakers: targets.map((s) => s.name), failed };
  }

  /** Create audio for all phrases in the background so the first trigger is instant. */
  async pregenerate() {
    for (const item of this.items()) {
      try {
        const a = await this.tts.getAudio(item.text, item.voice || this.defaultVoice);
        if (!a.cached) this.log.info(`Prepared audio for "${item.name}" (${a.voice})`);
      } catch (err) {
        this.log.warn(`Could not prepare "${item.name}": ${err.message}`);
      }
    }
  }
}

/**
 * HomeKit-friendly switch name from any text: letters, digits, spaces and apostrophes only,
 * starting and ending with a letter or digit, max ~40 characters on a word boundary.
 */
function switchName(text) {
  let s = String(text).replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > 40) {
    const cut = s.lastIndexOf(' ', 40);
    s = s.slice(0, cut > 15 ? cut : 40).trim();
  }
  s = s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return s || 'Announcement';
}

module.exports = { HomePodIsraelHebrewPlatform, PLUGIN_NAME, PLATFORM_NAME, CACHE_DIR, switchName };
