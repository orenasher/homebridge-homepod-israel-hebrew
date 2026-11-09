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
const DEFAULT_GROUP_NAME = 'קבצי הקול שלי';
const MAX_GROUP_SWITCHES = 90; // HomeKit allows up to 100 services per accessory

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
      if (this.engine) this.engine.stopDaemon();
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
    this.engine = new PyatvEnv(this.log, { pythonPath: cfg.pythonPath, storagePath: this.api.user.storagePath() });

    for (const s of cfg.speakers || []) {
      if (!s || !s.name) continue;
      this.speakers.set(s.name, new Speaker(s, this.engine, this.log));
    }
    if (!this.speakers.size) this.log.warn('No HomePods configured yet — open the plugin settings and tap "Find HomePods".');

    this.syncAccessories();

    if (cfg.webhook && cfg.webhook.enabled) {
      this.server = startWebhook(this, cfg.webhook, this.log);
    }

    // Prepare the voice engine and audio in the background.
    this.engine.ensure()
      .then(() => this.engine.warm([...this.speakers.values()].map((s) => ({ host: s.host, id: s.id }))))
      .then(() => this.log.info('Fast mode ready — HomePods located.'))
      .catch((err) => this.log.error(`Voice engine setup failed: ${err.message}`));
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
    const items = this.items();
    const wanted = new Set();

    if (this.config.groupSwitches) {
      // One accessory ("My voice files") holding a switch per phrase.
      const groupName = switchName(this.config.groupName || DEFAULT_GROUP_NAME);
      const uuid = this.api.hap.uuid.generate(`${PLATFORM_NAME}:group`);
      wanted.add(uuid);
      const shown = items.slice(0, MAX_GROUP_SWITCHES);
      if (items.length > shown.length) {
        this.log.warn(`A group can hold up to ${MAX_GROUP_SWITCHES} switches — ${items.length - shown.length} phrase(s) were left out.`);
      }
      this.ensureAccessory(uuid, groupName, (accessory) => {
        accessory.context.group = true;
        accessory.context.items = shown;
        const { Service } = this.api.hap;
        const keep = new Set(shown.map((i) => i.name));
        for (const svc of [...accessory.services]) {
          if (svc.UUID === Service.Switch.UUID && !keep.has(svc.subtype)) accessory.removeService(svc);
        }
        for (const item of shown) {
          const service = accessory.getServiceById(Service.Switch, item.name)
            || accessory.addService(Service.Switch, item.name, item.name);
          this.setupSwitch(service, item.name, () => (accessory.context.items || []).find((i) => i.name === item.name));
        }
      });
    } else {
      for (const item of items) {
        const uuid = this.api.hap.uuid.generate(`${PLATFORM_NAME}:${item.name}`);
        wanted.add(uuid);
        this.ensureAccessory(uuid, item.name, (accessory) => {
          accessory.context.group = false;
          accessory.context.item = item;
          const { Service } = this.api.hap;
          const service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, item.name);
          this.setupSwitch(service, item.name, () => accessory.context.item);
        });
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

  /** Create or refresh one accessory, then let `fill` add its switch services. */
  ensureAccessory(uuid, name, fill) {
    const { Service, Characteristic } = this.api.hap;
    let accessory = this.cached.get(uuid);
    const isNew = !accessory;
    if (isNew) accessory = new this.api.platformAccessory(name, uuid);
    if (accessory.displayName !== name) accessory.displayName = name;

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Name, name)
      .setCharacteristic(Characteristic.Manufacturer, 'Oren Asher')
      .setCharacteristic(Characteristic.Model, 'HomePod Israel Hebrew')
      .setCharacteristic(Characteristic.SerialNumber, uuid.slice(0, 13));

    fill(accessory);

    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.set(uuid, accessory);
      this.log.info(`Added "${name}"`);
    } else {
      this.api.updatePlatformAccessories([accessory]);
    }
  }

  /** A momentary switch that speaks its phrase. */
  setupSwitch(service, name, getItem) {
    const { Characteristic } = this.api.hap;
    service.setCharacteristic(Characteristic.Name, name);
    if (Characteristic.ConfiguredName) {
      try {
        if (!service.testCharacteristic(Characteristic.ConfiguredName)) service.addOptionalCharacteristic(Characteristic.ConfiguredName);
        service.setCharacteristic(Characteristic.ConfiguredName, name);
      } catch { /* older HAP */ }
    }
    const on = service.getCharacteristic(Characteristic.On);
    on.onGet(() => false);
    on.onSet((value) => {
      if (!value) return;
      // momentary: report "off" again so the next trigger works
      setTimeout(() => on.updateValue(false), 1000);
      const item = getItem();
      if (!item) return;
      this.announce(item).catch((err) => this.log.error(`"${item.name}": ${err.message}`));
    });
    on.updateValue(false);
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
    return this.say(item.text, {
      speakers: item.speakers, volume: item.volume, voice: item.voice, style: item.style, label: item.name,
    });
  }

  /**
   * Say any text.
   * @returns {Promise<{voice: string, cached: boolean, speakers: string[], failed: string[]}>}
   */
  async say(text, { speakers, volume, voice, style, label } = {}) {
    const targets = this.resolveSpeakers(speakers);
    if (!targets.length) throw new Error('no matching HomePods');

    const started = Date.now();
    const audio = await this.tts.getAudio(text, voice || this.defaultVoice, style || this.config.style);
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
        const a = await this.tts.getAudio(item.text, item.voice || this.defaultVoice, item.style || this.config.style);
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
