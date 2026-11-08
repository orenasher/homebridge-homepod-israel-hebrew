'use strict';

/* Helpers used by the settings screen: list Cartesia Hebrew voices, create an ElevenLabs voice clone. */

const { cartesiaRequest, fetchBuffer } = require('./tts');

/** Hebrew voices available in the user's Cartesia account / library. */
async function listCartesiaVoices(apiKey) {
  if (!apiKey) throw new Error('Cartesia API key is missing');
  const found = new Map();
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ language: 'he', limit: '100' });
    if (cursor) qs.set('starting_after', cursor);
    const buf = await cartesiaRequest(`/voices?${qs}`, apiKey, { method: 'GET' }, 30000);
    const json = JSON.parse(buf.toString('utf8'));
    const list = Array.isArray(json) ? json : (json.data || json.voices || []);
    for (const v of list) {
      if (!v || !v.id) continue;
      const lang = String(v.language || '').toLowerCase();
      if (lang && !lang.startsWith('he')) continue;
      const g = String(v.gender || '').toLowerCase();
      found.set(v.id, {
        id: v.id,
        name: v.name || v.id,
        description: v.description || '',
        gender: /^(fem|f$|woman)/.test(g) ? 'f' : (/^(masc|m$|man)/.test(g) ? 'm' : ''),
      });
    }
    if (!json.has_more || !list.length) break;
    cursor = list[list.length - 1].id;
  }
  return [...found.values()];
}

/**
 * Create an ElevenLabs Instant Voice Clone.
 * @param {string} apiKey
 * @param {string} name
 * @param {{name: string, type: string, data: Buffer}[]} files audio samples
 */
async function createElevenLabsClone(apiKey, name, files) {
  if (!apiKey) throw new Error('ElevenLabs API key is missing');
  if (!files.length) throw new Error('no recording');
  const form = new FormData();
  form.append('name', name || 'My voice');
  form.append('remove_background_noise', 'true');
  form.append('description', 'Created by HomePod Israel Hebrew');
  for (const f of files) {
    form.append('files', new Blob([f.data], { type: f.type || 'audio/mpeg' }), f.name || 'sample.m4a');
  }
  const buf = await fetchBuffer('https://api.elevenlabs.io/v1/voices/add', {
    method: 'POST', headers: { 'xi-api-key': apiKey }, body: form,
  }, 120000);
  const json = JSON.parse(buf.toString('utf8'));
  if (!json.voice_id) throw new Error('ElevenLabs did not return a voice ID');
  return { id: json.voice_id, name: name || 'My voice', requiresVerification: !!json.requires_verification };
}

module.exports = { listCartesiaVoices, createElevenLabsClone };
