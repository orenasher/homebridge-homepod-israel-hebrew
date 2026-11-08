'use strict';

const crypto = require('crypto');
const http = require('http');

const MAX_BODY = 64 * 1024;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/**
 * Endpoints:
 *   GET|POST /say?text=...&speakers=Kitchen,Bedroom&volume=50&engine=...&voice=...
 *   GET|POST /announce?name=<announcement name>
 *   GET      /status
 * Auth: ?token=... or header "Authorization: Bearer ..." when a token is set.
 */
function startWebhook(platform, cfg, log) {
  const port = Number(cfg.port) || 8095;
  const token = cfg.token ? String(cfg.token) : '';

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let params = Object.fromEntries(url.searchParams.entries());

      if (req.method === 'POST') {
        const raw = await readBody(req);
        if (raw.trim()) {
          const type = String(req.headers['content-type'] || '');
          if (type.includes('application/json')) {
            params = { ...params, ...JSON.parse(raw) };
          } else if (type.includes('application/x-www-form-urlencoded')) {
            params = { ...params, ...Object.fromEntries(new URLSearchParams(raw).entries()) };
          } else if (!params.text) {
            params.text = raw;
          }
        }
      } else if (req.method !== 'GET') {
        return send(res, 405, { ok: false, error: 'use GET or POST' });
      }

      if (token) {
        const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!safeEqual(params.token || auth, token)) return send(res, 401, { ok: false, error: 'bad token' });
      }

      const route = url.pathname.replace(/\/+$/, '') || '/';
      const wait = !['0', 'false', 'no'].includes(String(params.wait ?? '1').toLowerCase());

      if (route === '/status') {
        return send(res, 200, {
          ok: true,
          atvremote: platform.bin || null,
          speakers: [...platform.speakers.keys()],
          announcements: (platform.config.announcements || []).map((a) => a.name),
        });
      }

      let job;
      if (route === '/say') {
        if (!params.text) return send(res, 400, { ok: false, error: 'missing "text"' });
        job = platform.say(params.text, {
          speakers: params.speakers || params.speaker,
          volume: params.volume,
          engine: params.engine,
          voice: params.voice,
        });
      } else if (route === '/announce') {
        const item = (platform.config.announcements || [])
          .find((a) => a.name === params.name || (a.name || '').toLowerCase() === String(params.name || '').toLowerCase());
        if (!item) return send(res, 404, { ok: false, error: `no announcement named "${params.name || ''}"` });
        job = platform.announce({
          ...item,
          speakers: params.speakers || params.speaker || item.speakers,
          volume: params.volume ?? item.volume,
        });
      } else {
        return send(res, 404, { ok: false, error: 'unknown path — use /say, /announce or /status' });
      }

      if (!wait) {
        job.catch((err) => log.error(`Webhook: ${err.message}`));
        return send(res, 202, { ok: true, queued: true });
      }
      const result = await job;
      return send(res, 200, { ok: true, ...result });
    } catch (err) {
      log.error(`Webhook: ${err.message}`);
      return send(res, 500, { ok: false, error: err.message });
    }
  });

  server.on('error', (err) => log.error(`Webhook server error on port ${port}: ${err.message}`));
  server.listen(port, () => log.info(`Webhook listening on port ${port}${token ? ' (token required)' : ''}`));
  return server;
}

module.exports = { startWebhook };
