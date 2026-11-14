'use strict';

/*
 * Short attention tones played before an announcement. They are generated here as small WAV
 * files (no downloads, no extra packages) and kept in the plugin's cache folder.
 */
const fs = require('fs');
const path = require('path');

const RATE = 44100;

/** Tone presets: [frequency Hz, start s, length s] notes with a soft bell-like decay. */
const CHIMES = {
  // classic two-note "ding-dong"
  dingdong: { notes: [[659.25, 0, 0.9], [523.25, 0.45, 1.1]], gain: 0.45 },
  // gentle rising three notes
  soft: { notes: [[523.25, 0, 0.6], [659.25, 0.18, 0.6], [783.99, 0.36, 0.9]], gain: 0.35 },
  // urgent: three quick high beeps, twice
  urgent: {
    notes: [0, 0.16, 0.32, 0.7, 0.86, 1.02].map((t) => [987.77, t, 0.13]),
    gain: 0.5,
    sharp: true,
  },
};

function render({ notes, gain, sharp }) {
  const end = Math.max(...notes.map(([, start, len]) => start + len)) + 0.1;
  const total = Math.ceil(end * RATE);
  const samples = new Float32Array(total);
  for (const [freq, start, len] of notes) {
    const from = Math.floor(start * RATE);
    const n = Math.floor(len * RATE);
    for (let i = 0; i < n && from + i < total; i++) {
      const t = i / RATE;
      const attack = Math.min(1, t / 0.01);
      const env = sharp
        ? attack * (t > len - 0.02 ? Math.max(0, (len - t) / 0.02) : 1)
        : attack * Math.exp(-3.2 * t / len);
      // fundamental plus a quiet overtone gives a bell-ish colour
      const v = Math.sin(2 * Math.PI * freq * t) + 0.25 * Math.sin(2 * Math.PI * freq * 2 * t);
      samples[from + i] += v * env * gain * 0.8;
    }
  }
  const data = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Path of the WAV for a chime, created on first use. Returns null for unknown/disabled chimes. */
function chimeFile(dir, name) {
  const preset = CHIMES[name];
  if (!preset) return null;
  const file = path.join(dir, `chime-${name}-v1.wav`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, render(preset));
  }
  return file;
}

module.exports = { chimeFile, CHIMES };
