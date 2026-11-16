'use strict';
/**
 * zen-engine.js — Headless OpenCode Zen v2 Engine & Adapter for automatic-funicular (Singularity model_proxy)
 *
 * Stripped of all standalone HTTP dashboard bloat (no public/index.html, no /api/* admin routes,
 * no CORS/Origin browser guards, no CWE-770 per-IP rate limiter, no Claude Code wrapper routes).
 *
 * Provides:
 *  1. OpenCode v2 identity & header synthesis (`buildZenHeaders`, `genSessionId`, 30-min session+project rotation, W3C `b3`/`traceparent` tracing).
 *  2. OpenCode v2 Free-Tier Gate Bypass:
 *     - Harness system preamble injection (`agent-preamble.txt`)
 *     - OpenCode v2 tool manifest injection (`agent-tools.json`)
 *     - Bidirectional tool call remapping (`ANTIGRAVITY_TOOL_MAP` for Antigravity LanguageServer native tools:
 *       `read` -> `view_file`, `edit` -> `replace_file_content`, `write` -> `write_to_file`,
 *       `shell`/`bash` -> `run_command`, `grep` -> `grep_search`, `list`/`glob` -> `list_dir`/`find_by_name`)
 *     - Automatic population of required Antigravity metadata (`toolSummary`, `toolAction`, `WaitMsBeforeAsync`, `Cwd`)
 *     - Unoffered/hallucinated manifest tool stripping (`finalizeStreamToolCalls`, `finalizeMessageToolCalls`)
 *     - `/terminal/i` tool-name gate aliasing (`aliasGatedTools`)
 *  3. Native Android BoringSSL Transport (`requestZenUpstream`):
 *     - Cloudflare in front of `opencode.ai/inference/openai/v1` fingerprints the TLS stack and returns `429 FreeUsageLimitError`
 *       to Node.js OpenSSL 3.x handshakes while accepting BoringSSL handshakes (`200 OK`).
 *     - Uses `/system/bin/curl` (Android's native BoringSSL build) in unbuffered streaming mode (`-N --http1.1`)
 *       wrapped in an `http.IncomingMessage`-compatible `PassThrough` stream.
 *  4. Endpoint family routing & translation (`/v1/chat/completions` vs `/v1/responses` for `gpt-5*`, `gpt-6*`, `grok-*`, `muse-spark-*`).
 *  5. SSE stream-to-completion collector (`collectSseToCompletionJson`) for non-streaming callers (since v2 gate requires `stream: true`).
 *  6. Free model catalog discovery (`fetchZenFreeModels`, `loadShippedModels`).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { randomBytes, createHash } = require('node:crypto');

const DEFAULT_UPSTREAM = 'https://opencode.ai/inference/openai/v1';
const MODEL_LIST_BASE = 'https://opencode.ai/inference/v1';
const VALID_MODEL_ID = /^[A-Za-z0-9._:@+/%-]+$/;
const NOT_CHAT_SERVABLE = [/^jev-/];

const SYSTEM_BORINGSSL_CURL = '/system/bin/curl';
const DEFAULT_CA_CERT = path.resolve(__dirname, '../../../../../etc/tls/cert.pem');

const RESPONSES_MODEL_PATTERNS = [
  'gpt-5*',
  'gpt-6*',
  'grok-*',
  'muse-spark-*',
];

const SESSION_HEADERS = ['x-opencode-session', 'x-opencode-session-id'];
const SESSION_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SESSION_MAX_AGE_MS = 30 * 60 * 1000;

const ASSET_DIR = process.env.ZEN_ENGINE_DIR || __dirname;
const MODELS_PATH = process.env.ZEN_PROXY_MODELS || path.join(ASSET_DIR, 'models.json');
const AGENT_TOOLS_PATH = process.env.ZEN_PROXY_AGENT_TOOLS || path.join(ASSET_DIR, 'agent-tools.json');
const AGENT_PREAMBLE_PATH = process.env.ZEN_PROXY_AGENT_PREAMBLE || path.join(ASSET_DIR, 'agent-preamble.txt');
const PREAMBLE_MARKER = 'You are an AI agent running in OpenCode';

const BAKED_MODELS = [
  'mimo-v2.6-flash-free',
  'big-pickle',
  'nemotron-3.5-lightning-free',
  'deepseek-v4.1-flash-free',
  'nemotron-3.5-super-vl-free',
  'glm-5.3-flash-free',
  'beam-free',
  'flint-40b-free',
  'iceman-free',
  'inkling-2-small-free',
  'longcat-2.5-free',
  'minimax-m3.1-flash-free',
  'hy4-flash-free',
];

/**
 * Dual-mode tool mapping:
 * Maps OpenCode v2 manifest tool calls (`read`, `edit`, `write`, `shell`, `bash`, `grep`, `glob`, `list`)
 * directly onto Antigravity LanguageServer native tools (`view_file`, `replace_file_content`, `write_to_file`,
 * `run_command`, `grep_search`, `list_dir`, `find_by_name`) OR standard Claude/OpenAI agent tools if offered by the caller.
 */
const ANTIGRAVITY_TOOL_MAP = {
  read: {
    candidates: ['view_file', 'read_file', 'Read'],
    summary: 'Read file contents',
    action: 'Reading file',
    remapArgs(args, targetName) {
      if (targetName === 'view_file' || targetName === 'read_file') {
        const out = { AbsolutePath: args.path || args.filePath || args.file_path || '' };
        if (Number.isInteger(args.offset) && args.offset > 0) out.StartLine = args.offset;
        if (Number.isInteger(args.limit) && args.limit > 0) {
          out.EndLine = (out.StartLine || 1) + args.limit - 1;
        }
        return out;
      }
      return { file_path: args.path || args.filePath };
    },
  },
  edit: {
    candidates: ['replace_file_content', 'Edit'],
    summary: 'Edit file content',
    action: 'Editing file',
    remapArgs(args, targetName) {
      if (targetName === 'replace_file_content') {
        return {
          TargetFile: args.path || args.filePath || '',
          TargetContent: args.oldString || '',
          ReplacementContent: args.newString || '',
          AllowMultiple: Boolean(args.replaceAll),
          Instruction: 'Edit file content',
          Description: 'Replace target content in file',
          StartLine: 1,
          EndLine: 1,
        };
      }
      return {
        file_path: args.path || args.filePath,
        old_string: args.oldString,
        new_string: args.newString,
        replace_all: args.replaceAll,
      };
    },
  },
  write: {
    candidates: ['write_to_file', 'write_file', 'Write'],
    summary: 'Write file content',
    action: 'Writing file',
    remapArgs(args, targetName) {
      if (targetName === 'write_to_file') {
        return {
          TargetFile: args.path || args.filePath || '',
          CodeContent: args.content || '',
          Overwrite: true,
          Description: 'Write file content',
        };
      }
      if (targetName === 'write_file') {
        return {
          AbsolutePath: args.path || args.filePath || '',
          Content: args.content || '',
        };
      }
      return { file_path: args.path || args.filePath, content: args.content };
    },
  },
  shell: {
    candidates: ['run_command', 'Bash'],
    summary: 'Run shell command',
    action: 'Running command',
    remapArgs(args, targetName) {
      if (targetName === 'run_command') {
        return {
          CommandLine: args.command || '',
          Cwd: args.workdir || process.cwd(),
          WaitMsBeforeAsync: args.background ? 500 : 5000,
          IsDaemon: false,
        };
      }
      const out = { ...args };
      delete out.workdir;
      return out;
    },
  },
  bash: {
    candidates: ['run_command', 'Bash'],
    summary: 'Run shell command',
    action: 'Running command',
    remapArgs(args, targetName) {
      if (targetName === 'run_command') {
        return {
          CommandLine: args.command || '',
          Cwd: args.workdir || process.cwd(),
          WaitMsBeforeAsync: args.background ? 500 : 5000,
          IsDaemon: false,
        };
      }
      const out = { ...args };
      delete out.workdir;
      return out;
    },
  },
  grep: {
    candidates: ['grep_search', 'Grep'],
    summary: 'Search code pattern',
    action: 'Searching code',
    remapArgs(args, targetName) {
      if (targetName === 'grep_search') {
        return {
          Query: args.pattern || '',
          SearchPath: args.path || process.cwd(),
          CaseInsensitive: args.caseSensitive === false,
          IsRegex: !args.literal,
          MatchPerLine: true,
        };
      }
      return args;
    },
  },
  glob: {
    candidates: ['find_by_name', 'list_dir', 'Glob'],
    summary: 'Find files',
    action: 'Finding files',
    remapArgs(args, targetName) {
      if (targetName === 'find_by_name') {
        return { Pattern: args.pattern || '*', SearchDirectory: args.path || process.cwd() };
      }
      if (targetName === 'list_dir') {
        return { DirectoryPath: args.path || process.cwd() };
      }
      return args;
    },
  },
  list: {
    candidates: ['list_dir', 'LS'],
    summary: 'List directory',
    action: 'Listing directory',
    remapArgs(args, targetName) {
      if (targetName === 'list_dir') {
        return { DirectoryPath: args.path || process.cwd() };
      }
      return args;
    },
  },
};

function normalizeZenModelId(modelId) {
  const full = String(modelId || '').trim().replace(/^models\/(?:custom\/)?/, '');
  if (/^(?:opencode(?:-go)?|zen|openai|anthropic|google)\//i.test(full)) {
    return full.split('/').pop() || full;
  }
  return full;
}

// ─── 1. Session & Identity Pool ─────────────────────────────────────────────

let sessionClock = { ms: 0, ctr: 0 };
const traceRoot = randomBytes(16).toString('hex');
const identityPool = new Map();
const IDENTITY_POOL_MAX = 500;

function genSessionId(now = Date.now()) {
  if (now !== sessionClock.ms) {
    sessionClock.ms = now;
    sessionClock.ctr = 0;
  }
  sessionClock.ctr++;
  const stamp = BigInt(now) * 0x1000n + BigInt(sessionClock.ctr);
  const masked = ~stamp;
  const hex = Array.from({ length: 6 }, (_, i) =>
    Number((masked >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  ).join('');
  const tail = Array.from(randomBytes(14), (b) => SESSION_ALPHABET[b % 62]).join('');
  return { value: 'ses_' + hex + tail, at: now };
}

function genProjectHash(seed) {
  const input = seed ? `directory:${seed}` : `directory:${randomBytes(18).toString('hex')}`;
  return createHash('sha1').update(input).digest('hex');
}

function traceHeaders() {
  const span = randomBytes(8).toString('hex');
  const parent = randomBytes(8).toString('hex');
  return {
    b3: `${traceRoot}-${span}-1-${parent}`,
    traceparent: `00-${traceRoot}-${span}-01`,
  };
}

function identityForConversation(conversationKey = 'default', now = Date.now()) {
  const key = String(conversationKey || 'default');
  const hit = identityPool.get(key);
  if (hit && now - hit.at < SESSION_MAX_AGE_MS) {
    identityPool.delete(key);
    identityPool.set(key, hit);
    return hit;
  }
  const fresh = {
    ...genSessionId(now),
    project: genProjectHash(key !== 'default' ? key : undefined),
  };
  identityPool.delete(key);
  identityPool.set(key, fresh);
  for (const oldest of identityPool.keys()) {
    if (identityPool.size <= IDENTITY_POOL_MAX) break;
    identityPool.delete(oldest);
  }
  return fresh;
}

function buildZenHeaders({ apiKey = '', conversationKey = 'default', ua = 'opencode/latest/2.1.4/cli', clientName = 'cli', tracing = true } = {}) {
  const identity = identityForConversation(conversationKey);
  const auth = apiKey && apiKey !== 'none' && apiKey !== 'public' ? `Bearer ${apiKey.replace(/^Bearer\s+/i, '')}` : 'Bearer public';
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
    Authorization: auth,
    'User-Agent': ua,
    'x-opencode-client': clientName,
    'x-opencode-project': identity.project,
  };
  for (const h of SESSION_HEADERS) headers[h] = identity.value;
  headers['x-session-affinity'] = identity.value;
  headers['x-session-id'] = identity.value;
  if (tracing) {
    Object.assign(headers, traceHeaders());
  }
  return headers;
}

// ─── 2. Native Android BoringSSL Transport (`/system/bin/curl`) ──────────────

let hasBoringSslCurlCache = null;
function hasSystemBoringSslCurl() {
  if (hasBoringSslCurlCache !== null) return hasBoringSslCurlCache;
  try {
    fs.accessSync(SYSTEM_BORINGSSL_CURL, fs.constants.X_OK);
    hasBoringSslCurlCache = true;
  } catch {
    hasBoringSslCurlCache = false;
  }
  return hasBoringSslCurlCache;
}

function resolveCaCertPath() {
  const candidates = [
    process.env.SSL_CERT_FILE,
    process.env.CURL_CA_BUNDLE,
    DEFAULT_CA_CERT,
    '/data/user/0/dev.singularity.antigravity/files/usr/etc/tls/cert.pem',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return '';
}

/**
 * Executes an HTTPS POST via Android's native `/system/bin/curl` (BoringSSL TLS stack)
 * and returns a Promise resolving to an `http.IncomingMessage`-compatible stream
 * (`{ statusCode, headers, destroy, [Symbol.asyncIterator] }`) as soon as response headers arrive.
 */
function requestZenUpstream(url, { headers = {}, payload, timeoutMs = 120000, allowUnauthorized = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const args = [
      '-s',
      '-S',
      '-N',
      '-i',
      '--http1.1',
      '-X',
      'POST',
      '--max-time',
      String(Math.max(5, Math.ceil(timeoutMs / 1000))),
    ];
    if (allowUnauthorized) {
      args.push('-k');
    } else {
      const caCert = resolveCaCertPath();
      if (caCert) args.push('--cacert', caCert);
    }
    for (const [k, v] of Object.entries(headers)) {
      if (v != null && !/^(content-length|host|connection|transfer-encoding)$/i.test(k)) {
        args.push('-H', `${k}: ${v}`);
      }
    }
    args.push('--data-binary', '@-', String(url));

    // Clean environment ensures /system/bin/curl links against Android's native /system/lib64/libssl.so (BoringSSL)
    // instead of $PREFIX/lib/libssl.so (OpenSSL 3.x).
    const child = spawn(SYSTEM_BORINGSSL_CURL, args, {
      env: { PATH: '/system/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const bodyStream = new PassThrough();
    let headersResolved = false;
    let rawHeaderBuf = Buffer.alloc(0);
    let stderrText = '';

    const killChild = (err) => {
      try { child.kill('SIGKILL'); } catch {}
      if (!headersResolved) {
        headersResolved = true;
        reject(err || new Error('Cancelled'));
      } else if (err) {
        bodyStream.destroy(err);
      } else {
        bodyStream.end();
      }
    };

    bodyStream.destroy = (err) => {
      try { child.kill('SIGKILL'); } catch {}
      PassThrough.prototype.destroy.call(bodyStream, err);
      return bodyStream;
    };

    if (signal) {
      if (signal.aborted) {
        killChild(new Error('Cancelled'));
        return;
      }
      signal.addEventListener('abort', () => killChild(new Error('Cancelled')), { once: true });
    }

    child.stderr.on('data', (chunk) => {
      if (stderrText.length < 4096) stderrText += chunk.toString('utf8');
    });

    child.stdout.on('data', (chunk) => {
      if (headersResolved) {
        bodyStream.write(chunk);
        return;
      }
      rawHeaderBuf = Buffer.concat([rawHeaderBuf, chunk]);
      while (!headersResolved) {
        let sepIdx = rawHeaderBuf.indexOf('\r\n\r\n');
        let sepLen = 4;
        if (sepIdx < 0) {
          sepIdx = rawHeaderBuf.indexOf('\n\n');
          sepLen = 2;
        }
        if (sepIdx < 0) break;

        const headerBlock = rawHeaderBuf.subarray(0, sepIdx).toString('utf8');
        rawHeaderBuf = rawHeaderBuf.subarray(sepIdx + sepLen);
        const lines = headerBlock.split(/\r?\n/);
        const statusLine = lines[0] || '';
        const match = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})/i.exec(statusLine.trim());
        const statusCode = match ? Number(match[1]) : 502;

        // Skip intermediate 100 Continue / 103 Early Hints header blocks
        if (statusCode >= 100 && statusCode < 200) {
          continue;
        }

        const respHeaders = {};
        for (let i = 1; i < lines.length; i++) {
          const colon = lines[i].indexOf(':');
          if (colon > 0) {
            const hk = lines[i].slice(0, colon).trim().toLowerCase();
            const hv = lines[i].slice(colon + 1).trim();
            respHeaders[hk] = hv;
          }
        }

        bodyStream.statusCode = statusCode;
        bodyStream.headers = respHeaders;
        headersResolved = true;
        resolve(bodyStream);

        if (rawHeaderBuf.length > 0) {
          bodyStream.write(rawHeaderBuf);
          rawHeaderBuf = Buffer.alloc(0);
        }
      }
    });

    child.on('error', (err) => {
      killChild(err);
    });

    child.on('close', (code) => {
      if (!headersResolved) {
        headersResolved = true;
        reject(new Error(stderrText.trim() || `curl exited with code ${code}`));
      } else {
        bodyStream.end();
      }
    });

    child.stdin.on('error', () => {});
    child.stdin.end(bodyStr);
  });
}

// ─── 3. Preamble & Tool Manifest Gate Bridge ────────────────────────────────

let agentPreambleCache = null;
function loadPreamble() {
  if (agentPreambleCache !== null) return agentPreambleCache;
  try {
    agentPreambleCache = fs.readFileSync(AGENT_PREAMBLE_PATH, 'utf8');
  } catch {
    agentPreambleCache = '';
  }
  return agentPreambleCache;
}

let agentToolsCache = null;
function loadAgentTools() {
  if (agentToolsCache !== null) return agentToolsCache;
  agentToolsCache = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(AGENT_TOOLS_PATH, 'utf8'));
    const tools = Array.isArray(parsed?.tools) ? parsed.tools : Array.isArray(parsed) ? parsed : [];
    agentToolsCache = tools.filter((t) => t?.type === 'function' && t?.function?.name && ANTIGRAVITY_TOOL_MAP[t.function.name]);
  } catch {}
  return agentToolsCache;
}

function injectPreambleIntoMessages(messages) {
  const preamble = loadPreamble();
  if (!preamble || !Array.isArray(messages)) return messages;
  const idx = messages.findIndex((m) => m?.role === 'system');
  if (idx >= 0) {
    const existing = typeof messages[idx].content === 'string' ? messages[idx].content : '';
    if (existing.startsWith(PREAMBLE_MARKER)) return messages;
    const out = [...messages];
    out[idx] = { ...out[idx], content: existing ? `${preamble}\n\n${existing}` : preamble };
    return out;
  }
  return [{ role: 'system', content: preamble }, ...messages];
}

const GATED_TOOL_RE = /terminal/i;
function aliasGatedTools(tools) {
  const aliasMap = new Map();
  if (!Array.isArray(tools)) return { tools: [], aliasMap };
  const declared = new Set(tools.map((t) => t?.function?.name || t?.name).filter(Boolean));
  const cloned = tools.map((t) => {
    const fn = t?.function || t;
    const name = fn?.name;
    if (typeof name !== 'string' || !GATED_TOOL_RE.test(name)) return t;
    let alias = 'run_command_exec';
    for (let i = 2; declared.has(alias) || aliasMap.has(alias); i++) alias = `run_command_exec_${i}`;
    aliasMap.set(alias, name);
    return t.function ? { ...t, function: { ...t.function, name: alias } } : { ...t, name: alias };
  });
  return { tools: cloned, aliasMap };
}

function injectGateManifestTools(callerTools = []) {
  const bridge = loadAgentTools();
  const { tools: safeCallerTools, aliasMap } = aliasGatedTools(callerTools);
  const callerNames = new Set(safeCallerTools.map((t) => t?.function?.name || t?.name).filter(Boolean));
  const manifestNames = new Set(bridge.map((t) => t?.function?.name));
  const merged = bridge.length
    ? [...bridge, ...safeCallerTools.filter((t) => !manifestNames.has(t?.function?.name || t?.name))]
    : safeCallerTools;
  return {
    tools: merged,
    callerNames,
    aliasMap,
    bridgedCallerless: bridge.length > 0 && callerNames.size === 0,
  };
}

function ensureRequiredAntigravityMeta(toolName, argsObj, toolSchemas, defaultSummary, defaultAction) {
  if (!argsObj || typeof argsObj !== 'object' || Array.isArray(argsObj)) return argsObj;
  const out = { ...argsObj };
  const schema = toolSchemas instanceof Map ? toolSchemas.get(toolName) : undefined;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  if ((required.includes('toolSummary') || !schema) && !out.toolSummary) {
    out.toolSummary = defaultSummary || `Execute ${toolName}`;
  }
  if ((required.includes('toolAction') || !schema) && !out.toolAction) {
    out.toolAction = defaultAction || `Executing ${toolName}`;
  }
  if (toolName === 'run_command') {
    if (!out.Cwd) out.Cwd = process.cwd();
    if (out.WaitMsBeforeAsync == null) out.WaitMsBeforeAsync = 5000;
  } else if (toolName === 'write_to_file') {
    if (out.Overwrite == null) out.Overwrite = true;
    if (!out.Description) out.Description = defaultSummary || 'Write file content';
  }
  return out;
}

function resolveRemappedToolCall(rawName, rawArgs, callerNames, aliasMap, toolSchemas) {
  let parsed = {};
  try {
    parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {};
  } catch {
    parsed = {};
  }
  if (aliasMap && aliasMap.has(rawName)) {
    const restoredName = aliasMap.get(rawName);
    const enriched = ensureRequiredAntigravityMeta(restoredName, parsed, toolSchemas);
    return { name: restoredName, arguments: JSON.stringify(enriched) };
  }
  if (callerNames && callerNames.has(rawName)) {
    const enriched = ensureRequiredAntigravityMeta(rawName, parsed, toolSchemas);
    return { name: rawName, arguments: JSON.stringify(enriched) };
  }
  const spec = ANTIGRAVITY_TOOL_MAP[rawName];
  if (!spec) return null;
  const targetName = spec.candidates.find((c) => callerNames && callerNames.has(c));
  if (!targetName) return null;
  const remapped = spec.remapArgs(parsed, targetName);
  const enriched = ensureRequiredAntigravityMeta(targetName, remapped, toolSchemas, spec.summary, spec.action);
  return { name: targetName, arguments: JSON.stringify(enriched) };
}

function finalizeStreamToolCalls(streamContext, delta, gateBridge, toolSchemas) {
  if (!gateBridge) return streamContext;
  const ctx = streamContext || { accumulatedText: '', accumulatedReasoning: '', toolCalls: {} };
  if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!ctx.toolCalls[idx]) ctx.toolCalls[idx] = { id: '', name: '', arguments: '' };
      if (tc.id) ctx.toolCalls[idx].id = tc.id;
      if (tc.function?.name) ctx.toolCalls[idx].name += tc.function.name;
      if (tc.function?.arguments) ctx.toolCalls[idx].arguments += tc.function.arguments;
    }
    delete delta.tool_calls;
  }
  for (const [idx, tc] of Object.entries(ctx.toolCalls)) {
    const remapped = resolveRemappedToolCall(
      tc.name,
      tc.arguments,
      gateBridge.callerNames,
      gateBridge.aliasMap,
      toolSchemas
    );
    if (!remapped) {
      delete ctx.toolCalls[idx];
    } else {
      tc.name = remapped.name;
      tc.arguments = remapped.arguments;
    }
  }
  return ctx;
}

function finalizeMessageToolCalls(choice, gateBridge, toolSchemas) {
  if (!choice?.message || !gateBridge || !Array.isArray(choice.message.tool_calls)) return;
  const kept = [];
  for (const tc of choice.message.tool_calls) {
    const rawName = tc?.function?.name || tc?.name || '';
    const rawArgs = tc?.function?.arguments ?? tc?.arguments ?? '{}';
    const remapped = resolveRemappedToolCall(
      rawName,
      rawArgs,
      gateBridge.callerNames,
      gateBridge.aliasMap,
      toolSchemas
    );
    if (!remapped) continue;
    kept.push({
      ...tc,
      type: 'function',
      function: {
        ...(tc.function || {}),
        name: remapped.name,
        arguments: remapped.arguments,
      },
    });
  }
  if (kept.length) {
    choice.message.tool_calls = kept;
  } else {
    delete choice.message.tool_calls;
    if (choice.finish_reason === 'tool_calls') choice.finish_reason = 'stop';
  }
}

// ─── 4. Endpoint Family & Responses API Translation ─────────────────────────

function modelFormat(modelId, patterns = RESPONSES_MODEL_PATTERNS) {
  const bare = normalizeZenModelId(modelId);
  for (const p of patterns) {
    if (p.endsWith('*') ? bare.startsWith(p.slice(0, -1)) : bare === p) return 'responses';
  }
  return 'chat';
}

function getZenEndpointUrl(baseUrl, modelId) {
  const cleanBase = String(baseUrl || DEFAULT_UPSTREAM)
    .replace(/\/(?:chat\/completions|responses|messages)\/?$/, '')
    .replace(/\/+$/, '');
  const normalizedBase = cleanBase === 'https://opencode.ai/zen/v1' || cleanBase === 'https://opencode.ai/inference/v1'
    ? DEFAULT_UPSTREAM
    : cleanBase;
  const fmt = modelFormat(modelId);
  return `${normalizedBase}/${fmt === 'responses' ? 'responses' : 'chat/completions'}`;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p?.text || p?.content || p?.input_text || '')).filter(Boolean).join('');
  }
  return content == null ? '' : String(content);
}

function chatMessagesToResponsesInput(messages) {
  if (!Array.isArray(messages)) return String(messages || '');
  const items = [];
  for (const m of messages) {
    const role = m?.role || 'user';
    if (role === 'tool' || role === 'function') {
      items.push({
        type: 'function_call_output',
        call_id: m?.tool_call_id || m?.call_id || m?.id || 'call_0',
        output: textOf(m?.content) || ' ',
      });
      continue;
    }
    const text = textOf(m?.content);
    if (text) items.push({ role: role === 'assistant' ? 'assistant' : role, content: text });
    for (const tc of m?.tool_calls || []) {
      items.push({
        type: 'function_call',
        call_id: tc?.id || 'call_0',
        name: tc?.function?.name || tc?.name || 'unknown',
        arguments: tc?.function?.arguments || tc?.arguments || '{}',
      });
    }
  }
  return items.length ? items : [{ role: 'user', content: '' }];
}

function chatToolsToResponses(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const t of tools) {
    const fn = t?.type === 'function' ? (t.function || t) : null;
    if (!fn?.name) continue;
    out.push({
      type: 'function',
      name: fn.name,
      ...(fn.description ? { description: fn.description } : {}),
      ...(fn.parameters ? { parameters: fn.parameters } : {}),
      ...(fn.strict != null ? { strict: fn.strict } : {}),
    });
  }
  return out.length ? out : undefined;
}

function chatBodyToResponsesRequest(chatBody, modelId) {
  const payload = {
    model: normalizeZenModelId(modelId),
    input: chatMessagesToResponsesInput(chatBody.messages),
    stream: true,
  };
  if (chatBody.temperature != null) payload.temperature = chatBody.temperature;
  if (chatBody.top_p != null) payload.top_p = chatBody.top_p;
  const tools = chatToolsToResponses(chatBody.tools);
  if (tools) payload.tools = tools;
  const mt = chatBody.max_completion_tokens ?? chatBody.max_tokens;
  if (mt != null && Number.isFinite(Number(mt)) && Number(mt) > 0) {
    payload.max_output_tokens = Number(mt);
  }
  return payload;
}

function responsesEventToOpenAIChunk(event, state) {
  state.byId = state.byId || new Map();
  state.tools = state.tools || [];
  const type = event?.type || '';
  const base = {
    id: state.id || (state.id = `chatcmpl-${randomBytes(8).toString('hex')}`),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model || '',
  };

  if (type === 'response.output_text.delta' && event.delta) {
    return { ...base, choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] };
  }
  if ((type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') && event.delta) {
    return { ...base, choices: [{ index: 0, delta: { reasoning_content: event.delta }, finish_reason: null }] };
  }
  if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
    const item = event.item;
    const idx = state.tools.length;
    const callId = item.call_id || item.id || `call_${idx}`;
    for (const k of [item.item_id, item.call_id, item.id]) {
      if (k) state.byId.set(k, idx);
    }
    state.tools.push({ id: callId, name: item.name || 'unknown' });
    return {
      ...base,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: idx, id: callId, type: 'function', function: { name: item.name || 'unknown', arguments: '' } }] },
        finish_reason: null,
      }],
    };
  }
  if (type === 'response.function_call_arguments.delta' && event.delta) {
    const idx = state.byId.get(event.item_id) ?? state.byId.get(event.call_id) ?? Math.max(0, state.tools.length - 1);
    return {
      ...base,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: idx, function: { arguments: event.delta } }] },
        finish_reason: null,
      }],
    };
  }
  if (type === 'response.completed' || type === 'response.incomplete') {
    const finish = type === 'response.incomplete' ? 'length' : state.tools.length ? 'tool_calls' : 'stop';
    const u = event.response?.usage;
    return {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      ...(u ? {
        usage: {
          prompt_tokens: u.input_tokens || 0,
          completion_tokens: u.output_tokens || 0,
          total_tokens: u.total_tokens || (u.input_tokens || 0) + (u.output_tokens || 0),
        },
      } : {}),
    };
  }
  return null;
}

/**
 * Collects an SSE stream (either OpenAI chat.completion.chunk or Responses API events)
 * into a single OpenAI chat.completion JSON object for non-streaming callers.
 */
function collectSseToCompletionJson(rawSseText, zenFmt = 'chat', modelId = '') {
  const state = { model: modelId, byId: new Map(), tools: [] };
  let id = `chatcmpl-${randomBytes(8).toString('hex')}`;
  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage;
  const toolCallsMap = new Map();

  for (const rawLine of String(rawSseText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (parsed.error || parsed.type === 'error') {
      return { error: parsed.error || { message: parsed.message || 'Upstream stream error' } };
    }
    const chunk = zenFmt === 'responses' ? responsesEventToOpenAIChunk(parsed, state) : parsed;
    if (!chunk) continue;
    if (chunk.id) id = chunk.id;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.content) content += delta.content;
    if (delta.reasoning_content || delta.reasoning) reasoning += delta.reasoning_content || delta.reasoning;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const cur = toolCallsMap.get(idx) || { id: `call_${idx}`, type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        toolCallsMap.set(idx, cur);
      }
    }
  }

  const toolCalls = [...toolCallsMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
  const message = {
    role: 'assistant',
    content: content || (toolCalls.length ? null : ''),
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : finishReason }],
    ...(usage ? { usage } : {}),
  };
}

// ─── 5. Catalog Sync for custom_models.json ─────────────────────────────────

function loadShippedModels() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf8'));
    const list = Array.isArray(parsed?.models) ? parsed.models : [];
    const clean = list.filter((id) => typeof id === 'string' && VALID_MODEL_ID.test(id));
    if (clean.length) return clean;
  } catch {}
  return [...BAKED_MODELS];
}

async function fetchZenFreeModels(ua = 'opencode/latest/2.1.4/cli') {
  try {
    const res = await fetch(`${MODEL_LIST_BASE}/models`, {
      headers: { 'user-agent': ua },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ids = (data.data || [])
      .map((m) => m.id)
      .filter((id) => typeof id === 'string' && VALID_MODEL_ID.test(id) && !NOT_CHAT_SERVABLE.some((re) => re.test(id)))
      .filter((id) => id.endsWith('-free') || id === 'big-pickle');
    return ids.length ? ids : loadShippedModels();
  } catch {
    return loadShippedModels();
  }
}

module.exports = {
  DEFAULT_UPSTREAM,
  MODEL_LIST_BASE,
  RESPONSES_MODEL_PATTERNS,
  ANTIGRAVITY_TOOL_MAP,
  normalizeZenModelId,
  genSessionId,
  genProjectHash,
  identityForConversation,
  buildZenHeaders,
  hasSystemBoringSslCurl,
  requestZenUpstream,
  loadPreamble,
  loadAgentTools,
  injectPreambleIntoMessages,
  injectGateManifestTools,
  ensureRequiredAntigravityMeta,
  resolveRemappedToolCall,
  finalizeStreamToolCalls,
  finalizeMessageToolCalls,
  modelFormat,
  getZenEndpointUrl,
  chatBodyToResponsesRequest,
  responsesEventToOpenAIChunk,
  collectSseToCompletionJson,
  loadShippedModels,
  fetchZenFreeModels,
};
