'use strict';

const path = require('path');
const { TtsService } = require('./tts');
const { Speaker } = require('./player');
const { PyatvEnv } = require('./pyatv-env');
const { startWebhook } = require('./webhook');
const { DEFAULT_VOICE } = require('./voices');
const { chimeFile } = require('./chime');

const PLUGIN_NAME = 'homebridge-homepod-israel-hebrew';
const PLATFORM_NAME = 'HomePodIsraelHebrew';
const CACHE_DIR = 'homepod-israel-hebrew-cache';
const DEFAULT_GROUP_NAME = 'קבצי הקול שלי';
/** Seconds during which repeated triggers of one phrase are ignored (0 = only while playing). */
function repeatGuardMs(config) {
  const v = Number(config.repeatGuardSeconds);
  return (Number.isFinite(v) && v >= 0 ? Math.min(v, 600) : 10) * 1000;
}

/** "HH:MM" → minutes after midnight, or null. */
function parseClock(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** Quiet-hours settings in effect at `date`, or null when it is not quiet time. */
function quietNow(config, date = new Date()) {
  const q = config.quietHours;
  if (!q || !q.enabled) return null;
  const start = parseClock(q.start || '22:00');
  const end = parseClock(q.end || '07:00');
  if (start === null || end === null || start === end) return null;
  const now = date.getHours() * 60 + date.getMinutes();
  const inside = start < end ? now >= start && now < end : now >= start || now < end;
  if (!inside) return null;
  const vol = Number(q.volume);
  return { mute: q.mode === 'mute', volume: Number.isFinite(vol) ? Math.max(0, Math.min(100, vol)) : 25 };
}

const MAX_GROUP_SWITCHES = 90; // per group accessory; HomeKit allows about 100 services per accessory

class HomePodIsraelHebrewPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map();
    this.lastTrigger = new Map();
    this.speakers = new Map();
    this.online = new Map(); // HomePod name → last known reachability
    this.server = null;
    this.pingTimer = null;

    if (!config) {
      log.warn('No configuration found — plugin disabled.');
      return;
    }

    api.on('didFinishLaunching', () => {
      this.setup().catch((err) => this.log.error(`Startup failed: ${err.stack || err.message}`));
    });
    api.on('shutdown', () => {
      if (this.server) this.server.close();
      if (this.pingTimer) clearInterval(this.pingTimer);
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
      const speaker = new Speaker(s, this.engine, this.log);
      speaker.onResult = (ok) => this.setOnline(speaker, ok, ok ? 'played' : 'playback failed');
      this.speakers.set(s.name, speaker);
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
      .then(() => this.startAvailabilityChecks())
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
      // One accessory ("My voice files") holding a switch per phrase. HomeKit allows about 100
      // services per accessory, so a long list continues in "<name> 2", "<name> 3"...
      const baseName = switchName(this.config.groupName || DEFAULT_GROUP_NAME);
      for (let start = 0, n = 1; start < items.length || n === 1; start += MAX_GROUP_SWITCHES, n++) {
        const shown = items.slice(start, start + MAX_GROUP_SWITCHES);
        const uuid = this.api.hap.uuid.generate(n === 1 ? `${PLATFORM_NAME}:group` : `${PLATFORM_NAME}:group:${n}`);
        wanted.add(uuid);
        this.ensureAccessory(uuid, n === 1 ? baseName : `${baseName} ${n}`, (accessory) => {
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
        if (!items.length) break;
      }
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

    if (this.availabilityEnabled) {
      for (const speaker of this.speakers.values()) {
        const uuid = this.api.hap.uuid.generate(`${PLATFORM_NAME}:online:${speaker.name}`);
        wanted.add(uuid);
        this.ensureAccessory(uuid, switchName(`${speaker.name} מחובר`), (accessory) => {
          accessory.context.sensorFor = speaker.name;
          const { Service, Characteristic } = this.api.hap;
          const service = accessory.getService(Service.ContactSensor)
            || accessory.addService(Service.ContactSensor, accessory.displayName);
          const state = service.getCharacteristic(Characteristic.ContactSensorState);
          // closed (detected) = HomePod reachable, open = HomePod unreachable
          state.onGet(() => (this.online.get(speaker.name) === false
            ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            : Characteristic.ContactSensorState.CONTACT_DETECTED));
          speaker.sensor = service;
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
      // Guard against repeated triggers (e.g. an automation loop): while a phrase is playing,
      // and for a few seconds after it started, further triggers of the same phrase are ignored.
      const now = Date.now();
      const guardMs = repeatGuardMs(this.config);
      const last = this.lastTrigger.get(item.name);
      if (last && (last.busy || now - last.at < guardMs)) {
        last.ignored = (last.ignored || 0) + 1;
        if (last.ignored === 1) this.log.warn(`"${item.name}" was triggered again while still playing — ignoring repeats (an automation may be firing it in a loop).`);
        return;
      }
      const entry = { at: now, busy: true, ignored: 0 };
      this.lastTrigger.set(item.name, entry);
      this.announce(item)
        .catch((err) => this.log.error(`"${item.name}": ${err.message}`))
        .finally(() => {
          entry.busy = false;
          if (entry.ignored > 1) this.log.info(`"${item.name}": ignored ${entry.ignored} repeated triggers.`);
        });
    });
    on.updateValue(false);
  }

  /* ------------------------------------------------------------ availability */

  get availabilityEnabled() {
    const a = this.config.availability;
    return !!(a && a.enabled);
  }

  /** Record whether a HomePod is reachable and update its contact sensor. */
  setOnline(speaker, ok, why) {
    const before = this.online.get(speaker.name);
    this.online.set(speaker.name, ok);
    if (before !== undefined && before !== ok) {
      if (ok) this.log.info(`[${speaker.name}] HomePod is reachable again (${why}).`);
      else this.log.warn(`[${speaker.name}] HomePod is not reachable (${why}).`);
    }
    if (speaker.sensor) {
      const { Characteristic } = this.api.hap;
      speaker.sensor.updateCharacteristic(Characteristic.ContactSensorState, ok
        ? Characteristic.ContactSensorState.CONTACT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    }
  }

  /** Check every few minutes that each HomePod still answers on the network. */
  startAvailabilityChecks() {
    if (!this.availabilityEnabled || this.pingTimer || !this.speakers.size) return;
    const minutes = Math.max(1, Math.min(60, Number(this.config.availability.intervalMinutes) || 5));
    const check = async () => {
      for (const speaker of this.speakers.values()) {
        if (speaker.running) continue; // it is talking right now, so it is clearly there
        try {
          let ok = await speaker.ping();
          if (!ok) ok = await speaker.ping(); // one miss can be a Wi-Fi hiccup — ask again
          this.setOnline(speaker, ok, 'network check');
        } catch (err) {
          this.log.debug(`[${speaker.name}] availability check: ${err.message}`);
        }
      }
    };
    check();
    this.pingTimer = setInterval(check, minutes * 60000);
    if (this.pingTimer.unref) this.pingTimer.unref();
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
      speakers: item.speakers, volume: item.volume, voice: item.voice, style: item.style, label: item.name, urgent: item.urgent,
    });
  }

  /**
   * Say any text.
   * @returns {Promise<{voice: string, cached: boolean, speakers: string[], failed: string[]}>}
   */
  async say(text, { speakers, volume, voice, style, label, urgent } = {}) {
    const targets = this.resolveSpeakers(speakers);
    if (!targets.length) throw new Error('no matching HomePods');
    const tag0 = label ? `"${label}"` : `"${String(text).slice(0, 40)}"`;

    // Quiet hours: lower the volume or stay silent — urgent announcements always play normally.
    const quiet = urgent ? null : quietNow(this.config);
    if (quiet && quiet.mute) {
      this.log.info(`Quiet hours — ${tag0} was not played.`);
      return { voice: null, cached: false, speakers: [], failed: [], quiet: 'muted' };
    }

    const started = Date.now();
    const audio = await this.tts.getAudio(text, voice || this.defaultVoice, style || this.config.style);
    this.log.info(`Speaking ${tag0}${urgent ? ' (urgent)' : ''} on ${targets.map((s) => s.name).join(' + ')} `
      + `(${audio.voice}${audio.cached ? ', cached' : ''}${quiet ? `, quiet hours ${quiet.volume}%` : ''}, ready in ${Date.now() - started} ms)`);

    const files = [audio.file];
    const chime = this.chimeFor(urgent);
    if (chime) files.unshift(chime);

    const restore = this.config.restoreVolume !== false;
    const opts = { volume, restoreVolume: restore, urgent: !!urgent, maxVolume: quiet ? quiet.volume : undefined };
    const results = await Promise.allSettled(targets.map((s) => s.play(files, opts)));
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

  /** The attention tone to play first, or null. */
  chimeFor(urgent) {
    const c = this.config.chime;
    if (!c || !c.enabled) return null;
    let name = c.sound || 'dingdong';
    if (urgent) {
      if (c.urgentSound === 'none') return null;
      if (!c.urgentSound || c.urgentSound === 'urgent') name = 'urgent';
    }
    try {
      return chimeFile(path.join(this.api.user.storagePath(), CACHE_DIR), name);
    } catch (err) {
      this.log.warn(`Could not prepare the chime: ${err.message}`);
      return null;
    }
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

module.exports = { HomePodIsraelHebrewPlatform, PLUGIN_NAME, PLATFORM_NAME, CACHE_DIR, switchName, quietNow };
