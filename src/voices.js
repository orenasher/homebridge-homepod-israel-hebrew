'use strict';

/**
 * Voice catalog. Each preset maps to an engine + voice + optional style (rate/pitch).
 * Labels are bilingual so the settings screen can show them in Hebrew or English.
 */
const VOICES = [
  // ---- Microsoft Edge — free, no key. Native Hebrew voices in several styles.
  { id: 'hila', engine: 'edge', voice: 'he-IL-HilaNeural', gender: 'f', group: 'free',
    he: 'הילה — רגיל', en: 'Hila — natural' },
  { id: 'hila-calm', engine: 'edge', voice: 'he-IL-HilaNeural', rate: '-12%', pitch: '-2Hz', gender: 'f', group: 'free',
    he: 'הילה — רגוע ואיטי', en: 'Hila — calm & slow' },
  { id: 'hila-bright', engine: 'edge', voice: 'he-IL-HilaNeural', rate: '+8%', pitch: '+6Hz', gender: 'f', group: 'free',
    he: 'הילה — עליז ואנרגטי', en: 'Hila — bright & lively' },
  { id: 'hila-soft', engine: 'edge', voice: 'he-IL-HilaNeural', rate: '-5%', pitch: '-6Hz', gender: 'f', group: 'free',
    he: 'הילה — רך ונמוך', en: 'Hila — soft & low' },
  { id: 'avri', engine: 'edge', voice: 'he-IL-AvriNeural', gender: 'm', group: 'free',
    he: 'אברי — רגיל', en: 'Avri — natural' },
  { id: 'avri-deep', engine: 'edge', voice: 'he-IL-AvriNeural', rate: '-5%', pitch: '-10Hz', gender: 'm', group: 'free',
    he: 'אברי — קול עמוק', en: 'Avri — deep' },
  { id: 'avri-calm', engine: 'edge', voice: 'he-IL-AvriNeural', rate: '-12%', gender: 'm', group: 'free',
    he: 'אברי — רגוע ואיטי', en: 'Avri — calm & slow' },
  { id: 'avri-fast', engine: 'edge', voice: 'he-IL-AvriNeural', rate: '+12%', pitch: '+3Hz', gender: 'm', group: 'free',
    he: 'אברי — מהיר ונמרץ', en: 'Avri — quick & energetic' },

  // ---- Microsoft multilingual voices — free, may have a slight accent in Hebrew.
  { id: 'ava', engine: 'edge', voice: 'en-US-AvaMultilingualNeural', gender: 'f', group: 'multi',
    he: 'אווה — רב-לשוני (ניסיוני)', en: 'Ava — multilingual (experimental)' },
  { id: 'emma', engine: 'edge', voice: 'en-US-EmmaMultilingualNeural', gender: 'f', group: 'multi',
    he: 'אמה — רב-לשוני (ניסיוני)', en: 'Emma — multilingual (experimental)' },
  { id: 'seraphina', engine: 'edge', voice: 'de-DE-SeraphinaMultilingualNeural', gender: 'f', group: 'multi',
    he: 'סרפינה — רב-לשוני (ניסיוני)', en: 'Seraphina — multilingual (experimental)' },
  { id: 'andrew', engine: 'edge', voice: 'en-US-AndrewMultilingualNeural', gender: 'm', group: 'multi',
    he: 'אנדרו — רב-לשוני (ניסיוני)', en: 'Andrew — multilingual (experimental)' },
  { id: 'brian', engine: 'edge', voice: 'en-US-BrianMultilingualNeural', gender: 'm', group: 'multi',
    he: 'בריאן — רב-לשוני (ניסיוני)', en: 'Brian — multilingual (experimental)' },
  { id: 'remy', engine: 'edge', voice: 'fr-FR-RemyMultilingualNeural', gender: 'm', group: 'multi',
    he: 'רמי — רב-לשוני (ניסיוני)', en: 'Remy — multilingual (experimental)' },

  // ---- Google Chirp 3 HD — needs a Google Cloud API key. Very clear Hebrew.
  ...[
    ['Kore', 'f'], ['Aoede', 'f'], ['Leda', 'f'], ['Zephyr', 'f'], ['Callirrhoe', 'f'], ['Despina', 'f'],
    ['Gacrux', 'f'], ['Sulafat', 'f'],
    ['Charon', 'm'], ['Puck', 'm'], ['Fenrir', 'm'], ['Orus', 'm'], ['Enceladus', 'm'], ['Iapetus', 'm'],
    ['Algieba', 'm'], ['Umbriel', 'm'],
  ].map(([n, g]) => ({
    id: `google-${n.toLowerCase()}`, engine: 'googlecloud', voice: `he-IL-Chirp3-HD-${n}`, gender: g, group: 'google',
    he: `${n} — ${g === 'f' ? 'אישה' : 'גבר'} (Google)`, en: `${n} — ${g === 'f' ? 'female' : 'male'} (Google)`,
  })),

  // ---- ElevenLabs — needs an API key; uses the voice ID from the settings.
  { id: 'elevenlabs', engine: 'elevenlabs', gender: '', group: 'elevenlabs',
    he: 'ElevenLabs — הקול שבחרת', en: 'ElevenLabs — your chosen voice' },
];

const BY_ID = new Map(VOICES.map((v) => [v.id, v]));
const DEFAULT_VOICE = 'hila';

/** Legacy 1.0 engine names → preset. */
const LEGACY = { edge: 'hila', googlecloud: 'google-kore', elevenlabs: 'elevenlabs', googletranslate: 'translate' };

/**
 * Resolve a preset id (or a raw voice name) to engine options.
 * @param {string} id preset id, e.g. "avri-deep"; also accepts raw Edge/Google voice names.
 * @param {object} tts the "tts" config block (keys, ElevenLabs voice id, ...)
 */
function resolveVoice(id, tts = {}) {
  let key = id || DEFAULT_VOICE;
  if (LEGACY[key]) key = LEGACY[key];
  if (key === 'translate') return { id: key, engine: 'googletranslate', language: 'iw' };

  const preset = BY_ID.get(key);
  if (preset) {
    const opts = { id: preset.id, engine: preset.engine, voice: preset.voice, rate: preset.rate, pitch: preset.pitch };
    if (preset.engine === 'googlecloud') opts.apiKey = tts.googleApiKey;
    if (preset.engine === 'elevenlabs') {
      Object.assign(opts, {
        apiKey: tts.elevenlabsApiKey, voice: tts.elevenlabsVoiceId, model: tts.elevenlabsModel,
        language: tts.elevenlabsLanguage, stability: tts.elevenlabsStability, speed: tts.elevenlabsSpeed,
      });
    }
    return opts;
  }
  // raw voice names
  if (/Chirp|Wavenet|Neural2|Standard/i.test(key) && /^[a-z]{2}-[A-Z]{2}-/.test(key)) {
    return { id: key, engine: 'googlecloud', voice: key, apiKey: tts.googleApiKey };
  }
  if (/Neural$/.test(key)) return { id: key, engine: 'edge', voice: key };
  return resolveVoice(DEFAULT_VOICE, tts);
}

/** Public list for the settings screen. */
function listVoices() {
  return VOICES.map(({ id, gender, group, he, en, engine }) => ({ id, gender, group, he, en, engine }));
}

module.exports = { VOICES, DEFAULT_VOICE, resolveVoice, listVoices };
