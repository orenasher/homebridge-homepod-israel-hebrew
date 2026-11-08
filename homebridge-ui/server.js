'use strict';

/* Settings-screen backend: HomePod discovery, voice list, voice-engine status and live test playback. */

const path = require('path');
const { PyatvEnv } = require('../src/pyatv-env');
const { TtsService } = require('../src/tts');
const { Speaker } = require('../src/player');
const { listVoices } = require('../src/voices');
const { CACHE_DIR } = require('../src/platform');

const quietLog = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
  debug: () => {},
};

(async () => {
  const mod = await import('@homebridge/plugin-ui-utils');
  const { HomebridgePluginUiServer, RequestError } = mod.HomebridgePluginUiServer ? mod : mod.default;

  class UiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      this.env = new PyatvEnv(quietLog);

      this.onRequest('/voices', async () => listVoices());

      this.onRequest('/status', async (body = {}) => {
        if (body.pythonPath) this.env = new PyatvEnv(quietLog, { pythonPath: body.pythonPath });
        return { engine: this.env.status(), error: this.env.lastError || '' };
      });

      this.onRequest('/install', async () => {
        try {
          await this.env.ensure();
          return { engine: 'ready' };
        } catch (err) {
          throw new RequestError(err.message, { engine: 'error' });
        }
      });

      this.onRequest('/scan', async () => {
        try {
          await this.env.ensure();
          const reply = await this.env.helper({ cmd: 'scan', timeout: 6 }, 60000);
          return reply.devices;
        } catch (err) {
          throw new RequestError(err.message, {});
        }
      });

      this.onRequest('/test', async (body = {}) => {
        try {
          const text = String(body.text || '').trim();
          if (!text) throw new Error('empty text');
          const speakers = (body.speakers || []).filter((s) => s && (s.host || s.id));
          if (!speakers.length) throw new Error('no HomePod selected');
          const tts = new TtsService(body.tts || {}, path.join(this.homebridgeStoragePath, CACHE_DIR), quietLog);
          const audio = await tts.getAudio(text, body.voice);
          await this.env.ensure();
          const results = await Promise.allSettled(speakers.map((s) => new Speaker(s, this.env, quietLog)
            .play(audio.file, { volume: body.volume, restoreVolume: body.restoreVolume !== false })));
          const failed = results.map((r, i) => (r.status === 'rejected' ? `${speakers[i].name}: ${r.reason.message}` : null))
            .filter(Boolean);
          if (failed.length === speakers.length) throw new Error(failed.join(' | '));
          return { voice: audio.voice, cached: audio.cached, failed };
        } catch (err) {
          throw new RequestError(err.message, {});
        }
      });

      this.ready();
    }
  }

  // eslint-disable-next-line no-new
  new UiServer();
})();
