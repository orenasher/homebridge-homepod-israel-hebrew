'use strict';

/*
 * Self-managed pyatv: the plugin creates its own private Python environment with pinned,
 * known-good versions, so it never depends on anything installed by hand or by another plugin.
 * It lives outside the Homebridge storage folder (it is rebuilt automatically, so it does not
 * need to be in backups).
 */

const { execFile } = require('child_process');
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

class PyatvEnv {
  /**
   * @param {object} log logger with info/warn/error/debug
   * @param {object} [opts] { baseDir, pythonPath } — pythonPath = use an existing python with pyatv
   */
  constructor(log, opts = {}) {
    this.log = log;
    this.baseDir = opts.baseDir || path.join(os.homedir(), '.homepod-israel-hebrew');
    this.venv = path.join(this.baseDir, 'venv');
    this.stamp = path.join(this.baseDir, 'installed.txt');
    this.override = opts.pythonPath || '';
    this.installing = null;
    this.lastError = '';
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
    const check = await this.helper({ cmd: 'check' }, 60000);
    fs.writeFileSync(this.stamp, `${STAMP_VALUE}\n`);
    this.log.info(`Voice engine ready (pyatv ${check.pyatv}).`);
  }

  /** Run the python helper with JSON args; resolves to its JSON reply (rejects on ok:false). */
  async helper(args, timeoutMs = 180000) {
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

module.exports = { PyatvEnv, REQUIREMENTS };
