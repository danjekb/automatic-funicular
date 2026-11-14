#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');

function parseArgs(argv) {
  const opts = {
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.logFile) {
    process.env.AGY_MODEL_PROXY_LOG = path.resolve(opts.logFile);
  }

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

  writeJsonAtomic(stateFile, {
    version: 1,
    pid: process.pid,
    port: service.port,
    instance,
    token,
    managementUrl: `http://127.0.0.1:${service.port}/_addon/#token=${token}`,
  });

  console.log(`[model_proxy] READY port=${service.port} pid=${process.pid}`);
}

main().catch((err) => {
  console.error('[model_proxy] Fatal startup error:', err && err.stack ? err.stack : err);
  process.exit(1);
});
