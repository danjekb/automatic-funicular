#!/usr/bin/env bash
#
# integrate_gateway.sh - Automates integration of the multi-model gateway & proxy
# into the clean Antigravity Android codebase.
#
# Sources:
#   - App base: https://github.com/sahilsahilimtiyaz-code/antigravity-android-update
#   - Model proxy & gateway: https://github.com/vahapogut/antigravity-add-model
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADD_MODEL_DIR="${1:-$SCRIPT_DIR/../antigravity-add-model}"

echo "====================================================================="
echo " Antigravity Android Model Gateway Integration"
echo "====================================================================="

if [ ! -d "$ADD_MODEL_DIR/dist" ]; then
    echo "[!] Compiled dist not found in $ADD_MODEL_DIR. Attempting build..."
    if command -v npm >/dev/null 2>&1; then
        (cd "$ADD_MODEL_DIR" && npm run build)
    fi
fi

[ -d "$ADD_MODEL_DIR/dist" ] || {
    echo "[ERROR] Missing $ADD_MODEL_DIR/dist. Please build antigravity-add-model first." >&2
    exit 1
}

# 1. Stage model_proxy into env/overlay/lib/model_proxy/
PROXY_DST="$SCRIPT_DIR/env/overlay/lib/model_proxy"
echo "[*] Staging model proxy into $PROXY_DST..."
mkdir -p "$PROXY_DST/proxy/node_modules/electron-log"

# Custom models are a raw pass-through: the configured endpoint (FreeLLMAPI and
# similar gateways) owns format translation, so the upstream translator modules
# are excluded and this fork's transport files are never overwritten.
#   - proxy/proxy/translators/        schema + message + tool-call converters
#   - proxy/proxy/registry.js         translation dispatch and URL rewriting
#   - proxy/proxy/artifactMetadata.js response schema normalizer
#   - proxy/proxy/reasoningReplay.js  thought/reasoning replay cache
#   - proxy/proxy/passthrough.js      fork-owned raw HTTP/SSE transport
#   - proxy/proxy/customRequest.js    fork-owned pass-through alias
#   - proxy/proxy.js                  fork-owned routing (raw custom-model path)
tar -C "$ADD_MODEL_DIR/dist" \
    --exclude='./proxy/proxy/translators' \
    --exclude='./proxy/proxy/translators/*' \
    --exclude='./proxy/proxy/registry.*' \
    --exclude='./proxy/proxy/artifactMetadata.*' \
    --exclude='./proxy/proxy/reasoningReplay.*' \
    --exclude='./proxy/proxy/passthrough.*' \
    --exclude='./proxy/proxy/customRequest.*' \
    --exclude='./proxy/proxy.js' \
    --exclude='./proxy/proxy.js.map' \
    --exclude='./proxy/proxy.d.ts' \
    --exclude='./proxy/proxy.d.ts.map' \
    -cf - . | tar -C "$PROXY_DST/proxy" -xf -

# Purge anything a previous sync may have left behind.
rm -rf "$PROXY_DST/proxy/proxy/translators"
rm -f "$PROXY_DST/proxy/proxy/registry.js" "$PROXY_DST/proxy/proxy/registry.js.map" \
    "$PROXY_DST/proxy/proxy/registry.d.ts" "$PROXY_DST/proxy/proxy/registry.d.ts.map" \
    "$PROXY_DST/proxy/proxy/artifactMetadata.js" "$PROXY_DST/proxy/proxy/artifactMetadata.js.map" \
    "$PROXY_DST/proxy/proxy/artifactMetadata.d.ts" "$PROXY_DST/proxy/proxy/artifactMetadata.d.ts.map" \
    "$PROXY_DST/proxy/proxy/reasoningReplay.js" "$PROXY_DST/proxy/proxy/reasoningReplay.js.map" \
    "$PROXY_DST/proxy/proxy/reasoningReplay.d.ts" "$PROXY_DST/proxy/proxy/reasoningReplay.d.ts.map"

for required in "$PROXY_DST/proxy/proxy/passthrough.js" "$PROXY_DST/proxy/proxy/customRequest.js"; do
    [ -f "$required" ] || {
        echo "[ERROR] Missing fork-owned pass-through transport: $required" >&2
        exit 1
    }

done
if [ -d "$PROXY_DST/proxy/proxy/translators" ]; then
    echo "[ERROR] Translation modules are still present in $PROXY_DST/proxy." >&2
    exit 1
fi

# Ensure electron-log shim is in place
if [ ! -f "$PROXY_DST/proxy/node_modules/electron-log/index.js" ]; then
    cat <<'EOF' > "$PROXY_DST/proxy/node_modules/electron-log/index.js"
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const MAX_LOG_BYTES = 1024 * 1024;
const logFile = process.env.AGY_MODEL_PROXY_LOG || '';
let logDirReady = false;

function formatArgs(args) {
  return args.map((arg) => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }).join(' ');
}

function appendFileLine(line) {
  if (!logFile) return;
  try {
    if (!logDirReady) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
      logDirReady = true;
    }
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > MAX_LOG_BYTES) {
        const rotated = `${logFile}.1`;
        try { fs.unlinkSync(rotated); } catch {}
        fs.renameSync(logFile, rotated);
      }
    } catch {}
    fs.appendFileSync(logFile, line + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

function emit(level, args) {
  const ts = new Date().toISOString();
  const text = `${ts} [${level}] ${formatArgs(args)}`;
  if (level === 'ERROR' || level === 'WARN') console.error(text);
  else console.log(text);
  appendFileLine(text);
}

const logger = {
  info: (...args) => emit('INFO', args),
  warn: (...args) => emit('WARN', args),
  error: (...args) => emit('ERROR', args),
  debug: (...args) => emit('DEBUG', args),
  verbose: (...args) => emit('VERBOSE', args),
  silly: (...args) => emit('SILLY', args),
  log: (...args) => emit('INFO', args),
  transports: { file: { level: 'info', fileName: logFile }, console: { level: 'info' } },
  initialize: () => {},
};
logger.default = logger;
module.exports = logger;
EOF
fi

# Ensure entry.js exists
if [ ! -f "$PROXY_DST/entry.js" ]; then
    echo "[*] Creating entry.js runner..."
    cat <<'EOF' > "$PROXY_DST/entry.js"
#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');

function parseArgs(argv) {
  const opts = {
    port: 50998,
    dataDir: path.join(os.homedir(), '.gemini', 'antigravity-app'),
    logFile: process.env.AGY_MODEL_PROXY_LOG || '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (arg === '--data-dir' && argv[i + 1]) opts.dataDir = argv[++i];
    else if (arg === '--log-file' && argv[i + 1]) opts.logFile = argv[++i];
  }
  return opts;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, filePath);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.logFile) process.env.AGY_MODEL_PROXY_LOG = path.resolve(opts.logFile);
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
        const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (cur && cur.instance === instance) fs.unlinkSync(stateFile);
      }
    } catch {}
  };

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    cleanupState();
    try { if (service) await service.stop(); } catch {}
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  service = await startStandaloneService({
    port: opts.port,
    dataDirectory: canonicalDataDir,
    token,
    instance,
    onStop: () => { cleanupState(); process.exit(0); },
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
EOF
    chmod +x "$PROXY_DST/entry.js"
fi

# 2. Rebuild web bundles
echo "[*] Rebuilding web bundles..."
(cd "$SCRIPT_DIR/web" && bash build.sh)

echo "====================================================================="
echo "[OK] Model Gateway integration complete and verified!"
echo "     - Proxy bundled at: env/overlay/lib/model_proxy"
echo "     - Transport:        raw HTTP/SSE pass-through (no translation)"
echo "     - CLI management:   env/overlay/bin/agy-models"
echo "     - Web hook:         web/src/core/fetch-rewrite.js -> SetCloudCodeURL"
echo "     - Tests:            bash modules/gateway/tests/run_all.sh"
echo "====================================================================="
