'use strict';

/**
 * Voice catalog and speaking styles.
 *
 * A phrase has a VOICE (who speaks) and a STYLE (how they speak). Real variety comes from
 * different engines: Microsoft has only two Hebrew voices (Hila, Avri), while Gemini, Google
 * Chirp and ElevenLabs offer many genuinely different voices. Labels are bilingual for the UI.
 */

const GEMINI = [
  // name, gender, he, en
  ['Zephyr', 'f', 'בהיר', 'bright'], ['Kore', 'f', 'יציב', 'firm'], ['Leda', 'f', 'צעיר', 'youthful'],
  ['Aoede', 'f', 'קליל', 'breezy'], ['Achernar', 'f', 'רך', 'soft'], ['Sulafat', 'f', 'חם', 'warm'],
  ['Gacrux', 'f', 'בוגר', 'mature'], ['Vindemiatrix', 'f', 'עדין', 'gentle'],
  ['Puck', 'm', 'שמח', 'upbeat'], ['Charon', 'm', 'קריין', 'informative'], ['Fenrir', 'm', 'נלהב', 'excitable'],
  ['Algenib', 'm', 'צרוד', 'gravelly'], ['Enceladus', 'm', 'נושם', 'breathy'], ['Achird', 'm', 'ידידותי', 'friendly'],
  ['Sadaltager', 'm', 'מלומד', 'knowledgeable'], ['Iapetus', 'm', 'צלול', 'clear'],
];

const CHIRP = [
  ['Kore', 'f'], ['Aoede', 'f'], ['Leda', 'f'], ['Zephyr', 'f'], ['Callirrhoe', 'f'], ['Despina', 'f'],
  ['Charon', 'm'], ['Puck', 'm'], ['Fenrir', 'm'], ['Orus', 'm'], ['Enceladus', 'm'], ['Iapetus', 'm'],
];

const OPENAI = [
  // name, gender, he, en
  ['coral', 'f', 'חמה ושמחה', 'warm & upbeat'], ['nova', 'f', 'צעירה ואנרגטית', 'young & energetic'],
  ['shimmer', 'f', 'רכה', 'soft'], ['sage', 'f', 'רגועה', 'calm'], ['marin', 'f', 'טבעית', 'natural'],
  ['ash', 'm', 'ברור', 'clear'], ['echo', 'm', 'רך', 'soft'], ['onyx', 'm', 'עמוק', 'deep'],
  ['fable', 'm', 'מספר סיפורים', 'storyteller'], ['verse', 'm', 'דינמי', 'dynamic'], ['cedar', 'm', 'טבעי', 'natural'],
  ['ballad', 'm', 'רגשי', 'emotive'], ['alloy', 'n', 'ניטרלי', 'neutral'],
];

const VOICES = [
  // ---- Microsoft — free, no key. The only two native Hebrew voices Microsoft offers.
  { id: 'hila', engine: 'edge', voice: 'he-IL-HilaNeural', gender: 'f', group: 'free', he: 'הילה', en: 'Hila' },
  { id: 'avri', engine: 'edge', voice: 'he-IL-AvriNeural', gender: 'm', group: 'free', he: 'אברי', en: 'Avri' },

  // ---- Gemini — free API key (no credit card), 16 really different voices + real speaking styles.
  ...GEMINI.map(([n, g, he, en]) => ({
    id: `gemini-${n.toLowerCase()}`, engine: 'gemini', voice: n, gender: g, group: 'gemini',
    he: `${n} — ${he}`, en: `${n} — ${en}`,
  })),

  // ---- Microsoft multilingual — free, may have an accent in Hebrew.
  { id: 'ava', engine: 'edge', voice: 'en-US-AvaMultilingualNeural', gender: 'f', group: 'multi', he: 'אווה (רב-לשוני)', en: 'Ava (multilingual)' },
  { id: 'emma', engine: 'edge', voice: 'en-US-EmmaMultilingualNeural', gender: 'f', group: 'multi', he: 'אמה (רב-לשוני)', en: 'Emma (multilingual)' },
  { id: 'andrew', engine: 'edge', voice: 'en-US-AndrewMultilingualNeural', gender: 'm', group: 'multi', he: 'אנדרו (רב-לשוני)', en: 'Andrew (multilingual)' },

  // ---- Google Chirp 3 HD — Google Cloud key (billing account, free monthly tier).
  ...CHIRP.map(([n, g]) => ({
    id: `google-${n.toLowerCase()}`, engine: 'googlecloud', voice: `he-IL-Chirp3-HD-${n}`, gender: g, group: 'google',
    he: n, en: n,
  })),

  // ---- OpenAI gpt-4o-mini-tts — OpenAI key; follows style instructions (may have a slight accent).
  ...OPENAI.map(([n, g, he, en]) => ({
    id: `openai-${n}`, engine: 'openai', voice: n, gender: g === 'n' ? '' : g, group: 'openai',
    he: `${n[0].toUpperCase()}${n.slice(1)} — ${he}`, en: `${n[0].toUpperCase()}${n.slice(1)} — ${en}`,
  })),

  // ---- ElevenLabs — the voice ID from the settings.
  { id: 'elevenlabs', engine: 'elevenlabs', gender: '', group: 'elevenlabs', he: 'הקול שבחרת ב-ElevenLabs', en: 'Your ElevenLabs voice' },
];

/**
 * Speaking styles. Gemini performs them for real (it is told how to speak); ElevenLabs v3 gets an
 * audio tag; Microsoft and Google voices get a speed/pitch change as an approximation.
 */
const STYLES = [
  { id: 'normal', he: 'רגיל', en: 'Normal' },
  { id: 'cheerful', he: 'שמח ועליז', en: 'Cheerful',
    prompt: 'Say cheerfully, with a big smile', tag: '[happily]', rate: '+12%', pitch: '+12Hz', speed: 1.1 },
  { id: 'calm', he: 'רגוע ושקט', en: 'Calm & quiet',
    prompt: 'Say slowly, calmly and softly, like a relaxing evening message', tag: '[calmly]', rate: '-18%', pitch: '-6Hz', speed: 0.85 },
  { id: 'whisper', he: 'לחישה', en: 'Whisper',
    prompt: 'Whisper this quietly and gently', tag: '[whispers]', rate: '-15%', pitch: '-10Hz', speed: 0.9 },
  { id: 'announcer', he: 'כרוז רשמי', en: 'Announcer',
    prompt: 'Read this like a clear, formal public announcement at an airport', tag: '[formally]', rate: '-6%', pitch: '-4Hz', speed: 0.95 },
  { id: 'urgent', he: 'דחוף / אזהרה', en: 'Urgent warning',
    prompt: 'Say urgently and firmly, as an important warning that needs attention now', tag: '[urgently]', rate: '+18%', pitch: '+6Hz', speed: 1.15 },
  { id: 'warm', he: 'חם ואוהב', en: 'Warm & loving',
    prompt: 'Say warmly and lovingly, like a parent talking to their family', tag: '[warmly]', rate: '-8%', pitch: '+2Hz', speed: 0.95 },
  { id: 'excited', he: 'נרגש ומלא אנרגיה', en: 'Excited',
    prompt: 'Say with lots of excitement and energy', tag: '[excited]', rate: '+20%', pitch: '+18Hz', speed: 1.15 },
  { id: 'funny', he: 'מצחיק ושובב', en: 'Playful',
    prompt: 'Say playfully and humorously, with a teasing tone', tag: '[mischievously]', rate: '+5%', pitch: '+8Hz', speed: 1.05 },
];

/** Legacy ids from 1.0 / 1.1 → [voice, style]. */
const LEGACY = {
  edge: ['hila', 'normal'], googlecloud: ['google-kore', 'normal'], googletranslate: ['translate', 'normal'],
  'hila-calm': ['hila', 'calm'], 'hila-bright': ['hila', 'cheerful'], 'hila-soft': ['hila', 'warm'],
  'avri-deep': ['avri', 'announcer'], 'avri-calm': ['avri', 'calm'], 'avri-fast': ['avri', 'urgent'],
  seraphina: ['emma', 'normal'], remy: ['andrew', 'normal'], brian: ['andrew', 'normal'],
  'google-gacrux': ['google-kore', 'normal'], 'google-sulafat': ['google-aoede', 'normal'],
  'google-algieba': ['google-charon', 'normal'], 'google-umbriel': ['google-puck', 'normal'],
};

const BY_ID = new Map(VOICES.map((v) => [v.id, v]));
const STYLE_BY_ID = new Map(STYLES.map((s) => [s.id, s]));
const DEFAULT_VOICE = 'hila';

/**
 * Resolve a voice id (+ optional style) to engine options.
 * @param {string} id     voice id, legacy id, or raw Edge/Google voice name
 * @param {object} tts    the "tts" config block (keys, ElevenLabs voice id, ...)
 * @param {string} [styleId]
 */
function resolveVoice(id, tts = {}, styleId) {
  let key = id || DEFAULT_VOICE;
  let style = styleId;
  if (LEGACY[key]) {
    if (!style || style === 'normal') style = LEGACY[key][1];
    key = LEGACY[key][0];
  }
  const st = STYLE_BY_ID.get(style) || STYLE_BY_ID.get('normal');
  if (key === 'translate') return { id: key, engine: 'googletranslate', language: 'iw', style: 'normal' };

  const preset = BY_ID.get(key);
  let opts;
  if (key.startsWith('cartesia:')) {
    opts = { id: key, engine: 'cartesia', voice: key.slice(9) };
  } else if (key.startsWith('clone:')) {
    opts = { id: key, engine: 'elevenlabs', voice: key.slice(6) };
  } else if (preset) {
    opts = { id: preset.id, engine: preset.engine, voice: preset.voice };
  } else if (/Chirp|Wavenet|Neural2|Standard/i.test(key) && /^[a-z]{2}-[A-Z]{2}-/.test(key)) {
    opts = { id: key, engine: 'googlecloud', voice: key };
  } else if (/Neural$/.test(key)) {
    opts = { id: key, engine: 'edge', voice: key };
  } else {
    return resolveVoice(DEFAULT_VOICE, tts, style);
  }
  opts.style = st.id;

  switch (opts.engine) {
    case 'edge':
      if (st.rate) opts.rate = st.rate;
      if (st.pitch) opts.pitch = st.pitch;
      break;
    case 'gemini':
      opts.apiKey = tts.geminiApiKey;
      opts.model = tts.geminiModel;
      if (st.prompt) opts.prompt = st.prompt;
      break;
    case 'googlecloud':
      opts.apiKey = tts.googleApiKey;
      if (st.speed) opts.speakingRate = st.speed;
      break;
    case 'openai':
      opts.apiKey = tts.openaiApiKey;
      opts.model = tts.openaiModel;
      opts.prompt = st.prompt;
      break;
    case 'cartesia':
      opts.apiKey = tts.cartesiaApiKey;
      opts.model = tts.cartesiaModel;
      if (st.speed) opts.speed = st.speed;
      break;
    case 'elevenlabs':
      Object.assign(opts, {
        apiKey: tts.elevenlabsApiKey, voice: opts.voice || tts.elevenlabsVoiceId, model: tts.elevenlabsModel,
        language: tts.elevenlabsLanguage, stability: tts.elevenlabsStability, speed: tts.elevenlabsSpeed,
      });
      if (st.tag) opts.tag = st.tag;
      break;
    default:
  }
  return opts;
}

/** Public lists for the settings screen. */
function listVoices() {
  return VOICES.map(({ id, gender, group, he, en, engine }) => ({ id, gender, group, he, en, engine }));
}
function listStyles() {
  return STYLES.map(({ id, he, en }) => ({ id, he, en }));
}

module.exports = { VOICES, STYLES, DEFAULT_VOICE, resolveVoice, listVoices, listStyles };
