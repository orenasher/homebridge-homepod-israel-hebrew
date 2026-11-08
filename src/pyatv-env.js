'use strict';

/*
 * Self-managed pyatv: the plugin creates its own private Python environment with pinned,
 * known-good versions, so it never depends on anything installed by hand or by another plugin.
 * It lives outside the Homebridge storage folder (it is rebuilt automatically, so it does not
 * need to be in backups).
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REQUIREMENTS = ['pyatv==0.18.0', 'srptools>=0.2.0,<2'];
const STAMP_VALUE = `v1 ${REQUIREMENTS.join(' ')}`;
const HELPER = path.join(__dirname, 'speak.py');

function run(bin, args, timeoutMs, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        if (err.killed) err.message = `timed out after ${Math.round(timeoutMs / 1000)} s`;
        reject(err);
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

function executable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const ENGINE_DIR = 'homepod-israel-hebrew-engine';
const DEFAULT_STORAGE = process.env.UIX_STORAGE_PATH || '/var/lib/homebridge';

/* Versions before 1.4.0 kept the engine in ~/.homepod-israel-hebrew. It now lives in the
   Homebridge storage directory; once the new one is ready, remove the old copy. */
function removeLegacyEngine(currentDir, log) {
  const legacy = path.join(os.homedir(), '.homepod-israel-hebrew');
  if (path.resolve(legacy) === path.resolve(currentDir) || !fs.existsSync(path.join(legacy, 'venv'))) return;
  try {
    fs.rmSync(legacy, { recursive: true, force: true });
    log.info(`Removed the old voice engine folder ${legacy}.`);
  } catch (err) {
    log.debug(`Could not remove ${legacy}: ${err.message}`);
  }
}

class PyatvEnv {
  /**
   * @param {object} log logger with info/warn/error/debug
   * @param {object} [opts] { storagePath, baseDir, pythonPath } — the engine lives in the Homebridge
   *   storage directory; pythonPath = use an existing python with pyatv
   */
  constructor(log, opts = {}) {
    this.log = log;
    this.baseDir = opts.baseDir || path.join(opts.storagePath || DEFAULT_STORAGE, ENGINE_DIR);
    this.venv = path.join(this.baseDir, 'venv');
    this.stamp = path.join(this.baseDir, 'installed.txt');
    this.override = opts.pythonPath || '';
    this.installing = null;
    this.lastError = '';
    this.daemon = null;
    this.pending = new Map();
    this.nextRid = 1;
  }

  get python() {
    return this.override || path.join(this.venv, 'bin', 'python');
  }

  isReady() {
    if (this.override) return executable(this.override);
    try {
      return executable(this.python) && fs.readFileSync(this.stamp, 'utf8').trim() === STAMP_VALUE;
    } catch {
      return false;
    }
  }

  status() {
    if (this.isReady()) return 'ready';
    if (this.installing) return 'installing';
    return this.lastError ? 'error' : 'missing';
  }

  /** Make sure pyatv is installed. Safe to call many times; installs only once. */
  ensure() {
    if (this.isReady()) return Promise.resolve(this.python);
    if (!this.installing) {
      this.installing = this.install()
        .then(() => {
          this.lastError = '';
          return this.python;
        })
        .catch((err) => {
          this.lastError = err.message;
          throw err;
        })
        .finally(() => {
          this.installing = null;
        });
    }
    return this.installing;
  }

  async findSystemPython() {
    for (const p of ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3']) {
      if (executable(p)) return p;
    }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const p = path.join(dir, 'python3');
      if (executable(p)) return p;
    }
    throw new Error('Python 3 was not found. Install it with: sudo apt install -y python3 python3-venv');
  }

  /** Another process (Homebridge or the settings screen) may be installing — wait for it. */
  async waitForOtherInstaller(lock) {
    const deadline = Date.now() + 25 * 60000;
    while (fs.existsSync(lock) && Date.now() < deadline) {
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age > 25 * 60000) break; // stale lock
      await new Promise((r) => setTimeout(r, 3000));
      if (this.isReady()) return true;
    }
    return this.isReady();
  }

  async install() {
    fs.mkdirSync(this.baseDir, { recursive: true });
    const lock = path.join(this.baseDir, 'install.lock');
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch {
      if (await this.waitForOtherInstaller(lock)) return;
      fs.rmSync(lock, { force: true });
      fd = fs.openSync(lock, 'wx');
    }
    try {
      fs.writeSync(fd, String(process.pid));
      await this.doInstall();
    } finally {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
    }
  }

  async doInstall() {
    const python3 = await this.findSystemPython();
    this.log.info('Setting up the voice engine (pyatv) — one time, takes a few minutes…');
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.rmSync(this.venv, { recursive: true, force: true });
    try {
      await run(python3, ['-m', 'venv', this.venv], 120000);
    } catch (err) {
      throw new Error('Could not create a Python environment. Install venv support with: '
        + 'sudo apt install -y python3-venv   (then restart Homebridge). '
        + `Details: ${lastLine(err)}`);
    }
    try {
      await run(this.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
        '--upgrade', 'pip'], 600000);
    } catch (err) {
      this.log.debug(`pip upgrade skipped: ${lastLine(err)}`);
    }
    try {
      await run(this.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
        ...REQUIREMENTS], 1200000);
    } catch (err) {
      throw new Error(`Installing pyatv failed: ${lastLine(err)}`);
    }
    const check = await this.helperOnce({ cmd: 'check' }, 60000);
    fs.writeFileSync(this.stamp, `${STAMP_VALUE}\n`);
    this.log.info(`Voice engine ready (pyatv ${check.pyatv}).`);
    removeLegacyEngine(this.baseDir, this.log);
  }

  /*
   * Fast mode: one long-running helper keeps pyatv loaded and remembers where each HomePod is,
   * so an announcement starts without Python start-up or a network scan.
   */
  startDaemon() {
    if (this.daemon) return this.daemon.ready;
    const child = spawn(this.python, ['-I', HELPER, JSON.stringify({ cmd: 'serve' })], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let resolveReady;
    let rejectReady;
    const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    ready.catch(() => {});
    const d = { child, ready, alive: true };
    this.daemon = d;
    const startTimer = setTimeout(() => rejectReady(new Error('fast mode did not start')), 60000);

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ready) {
          clearTimeout(startTimer);
          resolveReady();
          continue;
        }
        const p = this.pending.get(msg.rid);
        if (!p) continue;
        this.pending.delete(msg.rid);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg);
        else p.reject(new Error(msg.error || 'failed'));
      }
    });
    child.stderr.on('data', (c) => this.log.debug(`[helper] ${String(c).trim()}`));
    const onExit = () => {
      if (!d.alive) return;
      d.alive = false;
      clearTimeout(startTimer);
      rejectReady(new Error('fast mode stopped'));
      if (this.daemon === d) this.daemon = null;
      for (const [rid, p] of this.pending) {
        if (p.daemon === d) {
          this.pending.delete(rid);
          clearTimeout(p.timer);
          p.reject(Object.assign(new Error('helper stopped'), { helperStopped: true }));
        }
      }
    };
    child.on('exit', onExit);
    child.on('error', onExit);
    // A write to a helper that just exited raises EPIPE on stdin; without a listener
    // Node would treat it as an uncaught exception and take Homebridge down with it.
    child.stdin.on('error', (err) => this.log.debug(`[helper] stdin: ${err.message}`));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    return ready;
  }

  stopDaemon() {
    if (this.daemon) {
      try { this.daemon.child.kill(); } catch { /* ignore */ }
      this.daemon = null;
    }
  }

  async daemonRequest(args, timeoutMs) {
    await this.startDaemon();
    const d = this.daemon;
    if (!d || !d.alive) throw Object.assign(new Error('helper stopped'), { helperStopped: true });
    const rid = this.nextRid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer, daemon: d });
      d.child.stdin.write(`${JSON.stringify({ ...args, rid })}\n`);
    });
  }

  /** Remember where the HomePods are ahead of time (makes the first announcement fast too). */
  async warm(devices) {
    if (!this.isReady() || !devices.length) return;
    try {
      await this.daemonRequest({ cmd: 'warm', devices }, 60000);
    } catch (err) {
      this.log.debug(`warm-up skipped: ${err.message}`);
    }
  }

  /** Run a helper command — fast mode first, one-shot process as a fallback. */
  async helper(args, timeoutMs = 180000) {
    if (args.cmd !== 'check' && this.isReady() && !this.noDaemon) {
      try {
        return await this.daemonRequest(args, timeoutMs);
      } catch (err) {
        // Only fall back when the helper itself failed to start or died before replying;
        // a real error from the HomePod is returned as-is.
        if (!err.helperStopped && !/fast mode/.test(err.message)) throw err;
        this.log.debug(`fast mode unavailable (${err.message}) — using one-shot helper`);
      }
    }
    return this.helperOnce(args, timeoutMs);
  }

  /** Run the python helper once with JSON args; resolves to its JSON reply (rejects on ok:false). */
  async helperOnce(args, timeoutMs = 180000) {
    let res;
    try {
      res = await run(this.python, ['-I', HELPER, JSON.stringify(args)], timeoutMs);
    } catch (err) {
      const reply = parseReply(err.stdout);
      const msg = (reply && reply.error) || lastLine(err);
      const e = new Error(msg);
      e.code = err.code;
      throw e;
    }
    const reply = parseReply(res.stdout);
    if (!reply) throw new Error(`unexpected helper output: ${res.stdout.slice(0, 200)}`);
    if (!reply.ok) throw new Error(reply.error || 'failed');
    return reply;
  }
}

function parseReply(stdout) {
  const line = String(stdout || '').trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function lastLine(err) {
  const text = `${err.stderr || ''}\n${err.stdout || ''}`.trim() || err.message;
  return text.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 400);
}

module.exports = { PyatvEnv, REQUIREMENTS, ENGINE_DIR };
