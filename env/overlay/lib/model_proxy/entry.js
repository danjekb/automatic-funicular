#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns');
const { randomBytes, randomUUID } = require('node:crypto');

// On Android, Bionic getaddrinfo can fail in daemonized userspace.
// Hook dns.lookup to resolve via public DNS (Google/Cloudflare) over c-ares.
try {
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4', '1.0.0.1']);
  const origLookup = dns.lookup;
  dns.lookup = function(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    dns.resolve4(hostname, (err, addrs) => {
      if (!err && addrs && addrs.length > 0) {
        if (options && options.all) {
          return callback(null, addrs.map(a => ({ address: a, family: 4 })));
        }
        return callback(null, addrs[0], 4);
      }
      origLookup(hostname, options, callback);
    });
  };
} catch (_) {}

function parseArgs(argv) {  const opts = {
    port: 50996,
    dataDir: path.join(os.homedir(), '.gemini', 'antigravity-app'),
    logFile: process.env.AGY_MODEL_PROXY_LOG || '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      opts.port = Number(argv[++i]);
    } else if (arg === '--data-dir' && argv[i + 1]) {
      opts.dataDir = argv[++i];
    } else if (arg === '--log-file' && argv[i + 1]) {
      opts.logFile = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node entry.js [--port <1-65535>] [--data-dir <dir>] [--log-file <path>]');
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error(`Invalid port: ${opts.port}`);
  }
  return opts;
}

function writeJsonAtomic(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o644,
      flag: 'w',
    });
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o644); } catch {}
  } catch (err) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', {
        encoding: 'utf8',
        mode: 0o644,
      });
      try { fs.chmodSync(filePath, 0o644); } catch {}
    } catch {}
  }
}

/**
 * Last-resort logging: the app redirects this process's stdout/stderr into the
 * proxy log, but a crash trace must also survive a closed pipe and be written
 * by the process itself. An uncaught exception exits so the Android supervisor
 * restarts the proxy; an unhandled rejection is logged without killing an
 * otherwise healthy proxy (aborted SSE streams are expected to reject).
 */
function installFatalHandlers(logFile) {
  const appendFatal = (kind, detail) => {
    const text = `${new Date().toISOString()} [FATAL] ${kind}: ${detail}`;
    try {
      console.error(text);
    } catch {}
    if (!logFile) return;
    try {
      fs.appendFileSync(logFile, text + '\n', { encoding: 'utf8' });
    } catch {}
  };
  const describe = (err) => (err && err.stack ? err.stack : String(err));
  process.on('uncaughtException', (err) => {
    appendFatal('uncaughtException', describe(err));
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    appendFatal('unhandledRejection', describe(reason));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.logFile) {
    process.env.AGY_MODEL_PROXY_LOG = path.resolve(opts.logFile);
  }
  installFatalHandlers(process.env.AGY_MODEL_PROXY_LOG || '');

  fs.mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  const canonicalDataDir = fs.realpathSync(opts.dataDir);
  const proxyStateDir = path.join(canonicalDataDir, '.ide-proxy');
  fs.mkdirSync(proxyStateDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(proxyStateDir, 'state.json');

  const token = randomBytes(32).toString('hex');
  const instance = randomUUID();

  const { startStandaloneService } = require('./proxy/standaloneService.js');
  let shuttingDown = false;
  let service;

  const cleanupState = () => {
    try {
      if (fs.existsSync(stateFile)) {
        const current = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (current && current.instance === instance) {
          fs.unlinkSync(stateFile);
        }
      }
    } catch {}
  };

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[model_proxy] Shutting down (${signal})...`);
    cleanupState();
    try {
      if (service) await service.stop();
    } catch {}
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  service = await startStandaloneService({
    port: opts.port,
    dataDirectory: canonicalDataDir,
    token,
    instance,
    onStop: () => {
      cleanupState();
      process.exit(0);
    },
  });

  const statePayload = {
    version: 1,
    pid: process.pid,
    port: service.port,
    instance,
    token,
    managementUrl: `http://127.0.0.1:${service.port}/_addon/#token=${token}`,
  };
  writeJsonAtomic(stateFile, statePayload);
  try {
    const parentDir = path.dirname(canonicalDataDir);
    const altStateDir = path.join(parentDir, 'antigravity', '.ide-proxy');
    writeJsonAtomic(path.join(altStateDir, 'state.json'), statePayload);
  } catch {}

  console.log(`[model_proxy] READY port=${service.port} pid=${process.pid}`);
}

/** Best-effort log path for failures that happen before --log-file is applied. */
function resolveLogFile(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--log-file' && argv[i + 1]) {
      return path.resolve(argv[i + 1]);
    }
  }
  return '';
}

main().catch((err) => {
  const detail = err && err.stack ? err.stack : String(err);
  console.error('[model_proxy] Fatal startup error:', detail);
  const logFile = process.env.AGY_MODEL_PROXY_LOG || resolveLogFile(process.argv.slice(2));
  if (logFile) {
    try {
      fs.appendFileSync(
        logFile,
        `${new Date().toISOString()} [FATAL] startup: ${detail}\n`,
        { encoding: 'utf8' }
      );
    } catch {}
  }
  process.exit(1);
});
