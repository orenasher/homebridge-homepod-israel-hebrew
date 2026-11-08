'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { resolveVoice, DEFAULT_VOICE } = require('./voices');

const DEFAULT_TIMEOUT_MS = 20000;

const DEFAULTS = {
  edge: { voice: 'he-IL-HilaNeural' },
  elevenlabs: { voice: '', model: 'eleven_v3', language: 'he' },
  googlecloud: { voice: 'he-IL-Chirp3-HD-Kore' },
  googletranslate: { language: 'iw' },
};

/** Fetch with timeout, returning a Buffer. Throws on non-2xx with a readable message. */
async function fetchBuffer(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      const body = buf.toString('utf8').slice(0, 300);
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${body}`);
    }
    return buf;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`request timed out after ${timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Split text into chunks of at most `max` characters, preferring sentence and word boundaries. */
function splitText(text, max) {
  const chunks = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = -1;
    for (const sep of ['. ', '! ', '? ', ', ', ' ']) {
      const idx = rest.lastIndexOf(sep, max);
      if (idx > max * 0.4) {
        cut = idx + sep.length - 1;
        break;
      }
    }
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/* ---------------------------------------------------------------- engines */

const engines = {
  /** Microsoft Edge "Read aloud" neural voices. Free, no key. */
  async edge(text, opts, outFile) {
    let EdgeTTS;
    try {
      ({ EdgeTTS } = require('node-edge-tts'));
    } catch (err) {
      throw new Error('node-edge-tts is not installed (reinstall the plugin)');
    }
    const tts = new EdgeTTS({
      voice: opts.voice || DEFAULTS.edge.voice,
      lang: opts.lang || 'he-IL',
      outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
      rate: opts.rate || 'default',
      pitch: opts.pitch || 'default',
      timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    });
    await tts.ttsPromise(text, outFile);
  },

  /** ElevenLabs — the most human-sounding option. Needs an API key and a voice ID. */
  async elevenlabs(text, opts, outFile) {
    if (!opts.apiKey) throw new Error('ElevenLabs API key is missing');
    const voice = opts.voice || DEFAULTS.elevenlabs.voice;
    if (!voice) throw new Error('ElevenLabs voice ID is missing');
    const model = opts.model || DEFAULTS.elevenlabs.model;
    const body = { text, model_id: model };
    const language = opts.language === undefined ? DEFAULTS.elevenlabs.language : opts.language;
    if (language) body.language_code = language;
    if (opts.stability !== undefined || opts.speed !== undefined) {
      body.voice_settings = {};
      if (opts.stability !== undefined) body.voice_settings.stability = opts.stability;
      if (opts.speed !== undefined) body.voice_settings.speed = opts.speed;
    }
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
    const buf = await fetchBuffer(url, {
      method: 'POST',
      headers: { 'xi-api-key': opts.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify(body),
    }, opts.timeoutMs || 45000);
    await fsp.writeFile(outFile, buf);
  },

  /** Google Cloud Text-to-Speech (Chirp 3 HD, WaveNet...). Needs an API key. */
  async googlecloud(text, opts, outFile) {
    if (!opts.apiKey) throw new Error('Google Cloud API key is missing');
    const voice = opts.voice || DEFAULTS.googlecloud.voice;
    const languageCode = voice.split('-').slice(0, 2).join('-');
    const audioConfig = { audioEncoding: 'MP3' };
    if (opts.speakingRate) audioConfig.speakingRate = opts.speakingRate;
    const buf = await fetchBuffer(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(opts.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { text }, voice: { languageCode, name: voice }, audioConfig }),
      },
      opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    );
    const json = JSON.parse(buf.toString('utf8'));
    if (!json.audioContent) throw new Error('Google Cloud returned no audio');
    await fsp.writeFile(outFile, Buffer.from(json.audioContent, 'base64'));
  },

  /** Google Translate voice — last-resort fallback, no key, robotic but always there. */
  async googletranslate(text, opts, outFile) {
    const tl = opts.language || DEFAULTS.googletranslate.language;
    const parts = splitText(text, 180);
    const buffers = [];
    for (let i = 0; i < parts.length; i++) {
      const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob'
        + `&tl=${encodeURIComponent(tl)}&total=${parts.length}&idx=${i}&textlen=${parts[i].length}`
        + `&q=${encodeURIComponent(parts[i])}`;
      buffers.push(await fetchBuffer(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, opts.timeoutMs));
    }
    await fsp.writeFile(outFile, Buffer.concat(buffers));
  },
};


/* ---------------------------------------------------------------- service */

class TtsService {
  /**
   * @param {object} config   the "tts" block of the platform config (API keys, fallback...)
   * @param {string} cacheDir folder for generated audio
   * @param {object} log      homebridge logger
   */
  constructor(config, cacheDir, log) {
    this.log = log;
    this.cacheDir = cacheDir;
    this.config = config || {};
    this.inflight = new Map();
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  /** Ordered list of resolved voices to try: the chosen one, then free fallbacks. */
  chain(voiceId) {
    const list = [resolveVoice(voiceId, this.config)];
    if (this.config.fallback !== false) {
      for (const id of [DEFAULT_VOICE, 'translate']) {
        if (!list.some((v) => v.id === id)) list.push(resolveVoice(id, this.config));
      }
    }
    return list;
  }

  cacheFile(opts, text) {
    const key = JSON.stringify([opts.engine, opts.voice || '', opts.model || '', opts.language || '',
      opts.rate || '', opts.pitch || '', opts.stability ?? '', opts.speed ?? '', text]);
    const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);
    return path.join(this.cacheDir, `${opts.engine}-${hash}.mp3`);
  }

  /**
   * Returns the path of an MP3 for `text`, generating it if needed.
   * @param {string} text
   * @param {string} [voiceId] preset id from voices.js
   */
  async getAudio(text, voiceId) {
    const clean = String(text || '').trim();
    if (!clean) throw new Error('nothing to say (empty text)');

    const errors = [];
    const chain = this.chain(voiceId);
    for (let i = 0; i < chain.length; i++) {
      const opts = chain[i];
      const file = this.cacheFile(opts, clean);
      if (await exists(file)) return { file, voice: opts.id, engine: opts.engine, cached: true };
      try {
        await this.generate(opts, clean, file);
        if (i > 0) this.log.warn(`Used fallback voice "${opts.id}" (${errors.join('; ')})`);
        return { file, voice: opts.id, engine: opts.engine, cached: false };
      } catch (err) {
        errors.push(`${opts.id}: ${err.message}`);
      }
    }
    throw new Error(`all voices failed — ${errors.join(' | ')}`);
  }

  async generate(opts, text, file) {
    if (this.inflight.has(file)) return this.inflight.get(file);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const job = (async () => {
      try {
        await engines[opts.engine](text, opts, tmp);
        const st = await fsp.stat(tmp);
        if (st.size < 200) throw new Error('generated audio is empty');
        await fsp.rename(tmp, file);
        this.log.debug(`Generated ${path.basename(file)} with ${opts.id}`);
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
    })();
    this.inflight.set(file, job);
    try {
      await job;
    } finally {
      this.inflight.delete(file);
    }
  }

  /** Deletes cached audio not played for `maxAgeDays`, plus leftover temp files. */
  async prune(maxAgeDays = 90) {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    let removed = 0;
    for (const name of await fsp.readdir(this.cacheDir)) {
      const full = path.join(this.cacheDir, name);
      try {
        const st = await fsp.stat(full);
        if (name.endsWith('.tmp') || st.atimeMs < cutoff) {
          await fsp.rm(full, { force: true });
          removed++;
        }
      } catch { /* ignore */ }
    }
    return removed;
  }
}

async function exists(file) {
  try {
    const st = await fsp.stat(file);
    if (st.size < 200) return false;
    const now = new Date();
    fsp.utimes(file, now, st.mtime).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

module.exports = { TtsService, splitText, engines };
