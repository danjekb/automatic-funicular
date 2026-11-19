"use strict";
/**
 * Raw pass-through transport for custom models.
 *
 * The configured endpoint (for example a FreeLLMAPI server) already performs
 * every wire-format and schema conversion. This module therefore performs no
 * message, tool-call, reasoning or schema mapping: the inbound request body,
 * query string and headers are forwarded as received (minus hop-by-hop and
 * credential headers), and the upstream response is streamed back untouched,
 * including SSE framing, status code, headers and error bodies.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProxyMetrics = getProxyMetrics;
exports.stopCustomRequests = stopCustomRequests;
exports.buildFallbackChain = buildFallbackChain;
exports.runCustomModelRequest = runCustomModelRequest;
exports.runPassthroughRequest = runPassthroughRequest;
const http = require("http");
const https = require("https");
const electron_log_1 = require("electron-log");
const controllers = new Set();
const counts = {
    requests: 0,
    active: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
};
function getProxyMetrics() {
    return { ...counts };
}
function stopCustomRequests() {
    for (const controller of controllers)
        controller.abort();
    controllers.clear();
}
function buildFallbackChain(primary, allModels) {
    const names = new Set([primary.name]);
    const chain = [primary];
    for (const name of primary.fallbackModels || []) {
        const model = allModels.find((candidate) => candidate.name === name && candidate.enabled !== false);
        if (model && !names.has(name)) {
            names.add(name);
            chain.push(model);
        }
    }
    return chain;
}
// Connection-scoped headers never belong to the forwarded message.
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);
// The IDE's own Google credentials must never reach a third-party endpoint.
const DROPPED_REQUEST_HEADERS = new Set(['host', 'content-length', 'authorization', 'x-api-key', 'x-goog-api-key']);
function scrub(source) {
    const headers = {};
    for (const [key, value] of Object.entries(source || {})) {
        if (value === undefined)
            continue;
        const name = key.toLowerCase();
        if (HOP_BY_HOP.has(name) || DROPPED_REQUEST_HEADERS.has(name))
            continue;
        headers[name] = value;
    }
    return headers;
}
function scrubResponse(source) {
    const headers = {};
    for (const [key, value] of Object.entries(source || {})) {
        if (value === undefined)
            continue;
        const name = key.toLowerCase();
        if (HOP_BY_HOP.has(name) || name === 'content-length')
            continue;
        headers[name] = value;
    }
    return headers;
}
/**
 * The configured URL is used verbatim. A bare origin (no path) keeps the
 * inbound RPC path, and an inbound query string is preserved unless the
 * configured endpoint already declares one.
 */
function resolveTarget(model, requestUrl) {
    const target = new URL(model.apiUrl);
    if (!['http:', 'https:'].includes(target.protocol))
        throw new Error('Unsupported endpoint protocol');
    let inbound;
    if (requestUrl) {
        try {
            inbound = new URL(requestUrl, 'http://127.0.0.1');
        }
        catch {
            inbound = undefined;
        }
    }
    if (inbound) {
        if (target.pathname === '/' || target.pathname === '')
            target.pathname = inbound.pathname;
        if (!target.search && inbound.search)
            target.search = inbound.search;
    }
    return target;
}
function applyApiKey(headers, model) {
    const key = model.apiKey;
    if (!key || key === 'none')
        return;
    if (/^(enc:|fallback:|local-gcm:|DECRYPTION_FAILED)/.test(key))
        throw new Error('API key could not be decrypted; save the key again.');
    headers.authorization = `Bearer ${key}`;
}
function applyCustomHeaders(headers, model) {
    for (const [key, value] of Object.entries(model.customHeaders || {})) {
        if (typeof value !== 'string')
            throw new Error('Custom headers must be strings');
        if (/^(host|content-length|connection|transfer-encoding)$/i.test(key))
            throw new Error('Reserved HTTP header');
        http.validateHeaderName(key);
        http.validateHeaderValue(key, value);
        headers[key.toLowerCase()] = value;
    }
}
function respondError(res, status, message) {
    if (res.destroyed || res.writableEnded || res.headersSent)
        return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message } }));
}
function writeHead(res, upstream) {
    const status = upstream.statusCode || 502;
    const headers = scrubResponse(upstream.headers);
    if (upstream.statusMessage)
        res.writeHead(status, upstream.statusMessage, headers);
    else
        res.writeHead(status, headers);
}
/**
 * Forward one request to the configured endpoint and stream the response back
 * byte-for-byte. No buffering, no parsing, no envelope, no retry: the upstream
 * owns its own format.
 */
function runPassthroughRequest(res, model, rawBody, incomingHeaders, requestUrl, method = 'POST') {
    return new Promise((resolve) => {
        if (res.destroyed || res.writableEnded) {
            resolve();
            return;
        }
        let target;
        let headers;
        let body;
        try {
            target = resolveTarget(model, requestUrl);
            headers = scrub(incomingHeaders);
            body = Buffer.isBuffer(rawBody)
                ? rawBody
                : rawBody === undefined || rawBody === null
                    ? Buffer.alloc(0)
                    : Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody), 'utf8');
            applyApiKey(headers, model);
            applyCustomHeaders(headers, model);
        }
        catch (error) {
            respondError(res, 400, `Invalid model configuration: ${error.message}`);
            resolve();
            return;
        }
        const controller = new AbortController();
        const { signal } = controller;
        controllers.add(controller);
        counts.requests += 1;
        counts.active += 1;
        let settled = false;
        let upstream;
        const finish = (outcome) => {
            if (settled)
                return;
            settled = true;
            controllers.delete(controller);
            counts.active -= 1;
            counts[outcome] += 1;
            resolve();
        };
        const abort = () => upstream?.destroy(new Error('Cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        res.once('close', () => {
            if (!res.writableEnded) {
                controller.abort();
                finish('cancelled');
            }
        });
        const client = target.protocol === 'https:' ? https : http;
        try {
            upstream = client.request(target, {
                method,
                headers,
                rejectUnauthorized: !model.allowUnauthorized,
            }, (upstreamRes) => {
                if (res.destroyed || res.writableEnded) {
                    upstreamRes.destroy();
                    return;
                }
                try {
                    writeHead(res, upstreamRes);
                }
                catch (error) {
                    upstreamRes.destroy();
                    respondError(res, 502, 'Invalid upstream response headers.');
                    finish('failed');
                    return;
                }
                upstreamRes.on('error', () => {
                    if (!res.writableEnded)
                        res.destroy();
                    finish('failed');
                });
                upstreamRes.once('end', () => finish('succeeded'));
                // Exact bytes, including SSE event framing.
                upstreamRes.pipe(res);
            });
        }
        catch (error) {
            respondError(res, 502, `Upstream connection failed: ${error.message}`);
            finish('failed');
            return;
        }
        upstream.once('error', (error) => {
            electron_log_1.default.warn('[Proxy] Pass-through upstream error:', error && error.message ? error.message : error);
            if (signal.aborted) {
                finish('cancelled');
                return;
            }
            respondError(res, 502, 'Upstream connection failed.');
            finish('failed');
        });
        upstream.setTimeout(model.idleTimeout ?? 300000, () => upstream.destroy(new Error('Upstream idle timeout.')));
        upstream.end(body);
    });
}
/**
 * Compatibility entry point used by the management "test generation" probe and
 * MCP delegation. The body is serialized once and forwarded unchanged; no
 * provider format is assumed or produced locally.
 */
async function runCustomModelRequest(res, primary, originalBody, isStream = true, allModels = [primary], _cloudEnvelope = true, _kind = 'request') {
    const model = primary || (allModels || [])[0];
    if (!model) {
        respondError(res, 400, 'No configured model is currently available.');
        return;
    }
    const headers = {
        'content-type': 'application/json',
        accept: isStream ? 'text/event-stream' : 'application/json',
    };
    await runPassthroughRequest(res, model, Buffer.from(JSON.stringify(originalBody ?? {}), 'utf8'), headers, undefined, 'POST');
}
//# sourceMappingURL=passthrough.js.map
