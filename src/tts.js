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

const CARTESIA_VERSIONS = ['2026-08-14', '2026-03-01', '2024-11-13'];

/** Call the Cartesia API, trying newer → older API versions if one is rejected. */
async function cartesiaRequest(pathname, apiKey, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let lastErr;
  for (const version of CARTESIA_VERSIONS) {
    try {
      return await fetchBuffer(`https://api.cartesia.ai${pathname}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${apiKey}`, 'X-API-Key': apiKey, 'Cartesia-Version': version,
          'Content-Type': 'application/json', ...(init.headers || {}),
        },
      }, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (!/version/i.test(err.message)) throw err;
    }
  }
  throw lastErr;
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

/** Wrap 16-bit mono PCM in a WAV header. */
function pcmToWav(pcm, sampleRate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
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
    const tagged = opts.tag && /v3|v4/.test(model) ? `${opts.tag} ${text}` : text;
    const body = { text: tagged, model_id: model };
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

  /**
   * Gemini TTS — free API key from Google AI Studio. Many distinct voices, and it really performs
   * the requested style (cheerful, whisper, announcer…). Returns raw PCM, saved as WAV.
   */
  async gemini(text, opts, outFile) {
    if (!opts.apiKey) throw new Error('Gemini API key is missing');
    const models = opts.model ? [opts.model] : ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'];
    const how = opts.prompt || 'Read this aloud naturally and clearly';
    const prompt = `${how}, in the language it is written in (Hebrew = native Israeli accent):\n${text}`;
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice || 'Kore' } } },
      },
    });
    let lastErr;
    for (const model of models) {
      try {
        const buf = await fetchBuffer(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey }, body },
          opts.timeoutMs || 60000,
        );
        const json = JSON.parse(buf.toString('utf8'));
        const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
        const audio = parts.find((p) => p.inlineData && p.inlineData.data);
        if (!audio) throw new Error('Gemini returned no audio');
        const rate = Number((/rate=(\d+)/.exec(audio.inlineData.mimeType || '') || [])[1]) || 24000;
        await fsp.writeFile(outFile, pcmToWav(Buffer.from(audio.inlineData.data, 'base64'), rate));
        return;
      } catch (err) {
        lastErr = err;
        if (!/HTTP 404/.test(err.message)) throw err; // only try the next model if this one doesn't exist
      }
    }
    throw lastErr;
  },

  /** OpenAI gpt-4o-mini-tts — many voices, follows free-text speaking instructions. */
  async openai(text, opts, outFile) {
    if (!opts.apiKey) throw new Error('OpenAI API key is missing');
    const how = opts.prompt ? `${opts.prompt}.` : 'Speak naturally and clearly.';
    const instructions = `${how} If the text is Hebrew, speak fluent native Israeli Hebrew with a natural Israeli accent.`;
    const buf = await fetchBuffer('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model || 'gpt-4o-mini-tts', voice: opts.voice || 'coral', input: text, instructions, response_format: 'mp3',
      }),
    }, opts.timeoutMs || 60000);
    await fsp.writeFile(outFile, buf);
  },

  /** Cartesia Sonic — native Hebrew voices. Voice IDs come from the voice list in the settings. */
  async cartesia(text, opts, outFile) {
    if (!opts.apiKey) throw new Error('Cartesia API key is missing');
    if (!opts.voice) throw new Error('Cartesia voice is missing');
    const models = opts.model ? [opts.model] : ['sonic-3.5', 'sonic-3'];
    let lastErr;
    for (const model of models) {
      const body = {
        model_id: model,
        transcript: text,
        voice: { mode: 'id', id: opts.voice },
        language: /[\u0590-\u05FF]/.test(text) ? 'he' : 'en',
        output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
      };
      if (opts.speed && opts.speed !== 1) body.generation_config = { speed: opts.speed };
      try {
        const buf = await cartesiaRequest('/tts/bytes', opts.apiKey, { method: 'POST', body: JSON.stringify(body) }, opts.timeoutMs || 60000);
        await fsp.writeFile(outFile, buf);
        return;
      } catch (err) {
        lastErr = err;
        if (!/HTTP 4(00|04|22)/.test(err.message)) throw err;
      }
    }
    throw lastErr;
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

/** Describe a fallback so the settings screen can say why another voice was used. */
function fellBack(chain, i, errors) {
  return i > 0 ? { requested: chain[0].id, fallbackReason: errors[0] || '' } : {};
}

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
  chain(voiceId, styleId) {
    const first = resolveVoice(voiceId, this.config, styleId);
    const list = [first];
    if (this.config.fallback !== false) {
      for (const id of [DEFAULT_VOICE, 'translate']) {
        if (!list.some((v) => v.id === id)) list.push(resolveVoice(id, this.config, first.style));
      }
    }
    return list;
  }

  cacheFile(opts, text) {
    const key = JSON.stringify([opts.engine, opts.voice || '', opts.model || '', opts.language || '',
      opts.rate || '', opts.pitch || '', opts.stability ?? '', opts.speed ?? '', opts.speakingRate ?? '',
      opts.prompt || '', opts.tag || '', text]);
    const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);
    const ext = opts.engine === 'gemini' ? 'wav' : 'mp3';
    return path.join(this.cacheDir, `${opts.engine}-${hash}.${ext}`);
  }

  /**
   * Returns the path of an MP3 for `text`, generating it if needed.
   * @param {string} text
   * @param {string} [voiceId] voice id from voices.js
   * @param {string} [styleId] style id from voices.js
   */
  async getAudio(text, voiceId, styleId) {
    const clean = String(text || '').trim();
    if (!clean) throw new Error('nothing to say (empty text)');

    const errors = [];
    const chain = this.chain(voiceId, styleId);
    for (let i = 0; i < chain.length; i++) {
      const opts = chain[i];
      const file = this.cacheFile(opts, clean);
      if (await exists(file)) {
        if (i > 0) this.log.warn(`Used fallback voice "${opts.id}" (${errors.join('; ')})`);
        return { file, voice: opts.id, engine: opts.engine, cached: true, ...fellBack(chain, i, errors) };
      }
      try {
        await this.generate(opts, clean, file);
        if (i > 0) this.log.warn(`Used fallback voice "${opts.id}" (${errors.join('; ')})`);
        return { file, voice: opts.id, engine: opts.engine, cached: false, ...fellBack(chain, i, errors) };
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

module.exports = { TtsService, splitText, engines, pcmToWav, cartesiaRequest, fetchBuffer };
