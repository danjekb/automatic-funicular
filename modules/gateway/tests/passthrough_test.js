"use strict";
/**
 * Verifies the gateway custom-model path is a raw pass-through:
 * request bytes/headers/query go up unchanged, the upstream response is streamed
 * back byte-for-byte, and no translation module remains in the tree.
 */
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { Writable } = require('node:stream');

const PROXY_ROOT = path.resolve(__dirname, '../../../env/overlay/lib/model_proxy/proxy');
const passthrough = require(path.join(PROXY_ROOT, 'proxy/passthrough.js'));
const { validateCustomModel } = require(path.join(PROXY_ROOT, 'schemaValidator.js'));
const { PROVIDERS, resolveApiFormat } = require(path.join(PROXY_ROOT, 'providers.js'));

class Sink extends Writable {
    constructor() {
        super();
        this.statusCode = 0;
        this.statusMessage = '';
        this.headers = null;
        this.headersSent = false;
        this.chunks = [];
    }
    writeHead(status, messageOrHeaders, maybeHeaders) {
        this.statusCode = status;
        if (typeof messageOrHeaders === 'string') {
            this.statusMessage = messageOrHeaders;
            this.headers = maybeHeaders || {};
        }
        else {
            this.headers = messageOrHeaders || {};
        }
        this.headersSent = true;
        return this;
    }
    _write(chunk, _encoding, done) {
        this.chunks.push(Buffer.from(chunk));
        done();
    }
    get body() {
        return Buffer.concat(this.chunks);
    }
}

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

async function main() {
    const seen = {};
    const { server, port } = await listen((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            seen.method = req.method;
            seen.url = req.url;
            seen.headers = req.headers;
            seen.body = Buffer.concat(chunks).toString('utf8');
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'X-Upstream-Marker': 'free-llm-api',
            });
            res.write('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n');
            res.end('data: [DONE]\n\n');
        });
    });

    const model = {
        name: 'models/freellmapi-gpt',
        provider: 'free-llm-api',
        apiFormat: 'passthrough',
        apiUrl: `http://127.0.0.1:${port}/v1/raw`,
        apiKey: 'freellmapi-test-key',
        customHeaders: { 'X-Tenant': 'singularity' },
    };

    // A. The exact inbound request reaches the endpoint; the response is untouched.
    const inbound = Buffer.from(JSON.stringify({
        model: 'models/freellmapi-gpt',
        request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }], tools: [{ functionDeclarations: [{ name: 'x', parameters: { type: ['string', 'null'] } }] }] },
    }), 'utf8');
    const sink = new Sink();
    await passthrough.runPassthroughRequest(sink, model, inbound, {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: 'Bearer google-ide-token',
        'x-goog-api-key': 'google-ide-key',
        connection: 'keep-alive',
        te: 'trailers',
        upgrade: 'websocket',
    }, '/v1internal:streamGenerateContent?alt=sse', 'POST');

    assert.strictEqual(sink.statusCode, 200, 'upstream status must be preserved');
    assert.strictEqual(sink.headers['x-upstream-marker'], 'free-llm-api', 'upstream headers must be preserved');
    assert.strictEqual(sink.body.toString('utf8'), 'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\ndata: [DONE]\n\n', 'SSE bytes must be forwarded untouched');
    assert.strictEqual(seen.body, inbound.toString('utf8'), 'request body must not be rewritten');
    assert.deepStrictEqual(JSON.parse(seen.body), JSON.parse(inbound.toString('utf8')), 'no schema normalization may occur');
    assert.strictEqual(seen.headers.authorization, 'Bearer freellmapi-test-key', 'configured key replaces IDE credentials');
    assert.strictEqual(seen.headers['x-goog-api-key'], undefined, 'IDE Google key must not leak upstream');
    assert.strictEqual(seen.headers['x-tenant'], 'singularity', 'custom headers are applied');
    assert.strictEqual(seen.headers.te, undefined, 'hop-by-hop headers are dropped');
    assert.strictEqual(seen.headers.upgrade, undefined, 'upgrade headers are dropped');
    assert.strictEqual(seen.headers['content-length'], String(inbound.length), 'body length is computed from the forwarded bytes');
    assert.strictEqual(seen.url, '/v1/raw?alt=sse', 'inbound query is preserved, path is the configured endpoint');

    // B. A bare-origin endpoint keeps the inbound RPC path and query.
    const bare = { ...model, apiUrl: `http://127.0.0.1:${port}` };
    const sinkBare = new Sink();
    await passthrough.runPassthroughRequest(sinkBare, bare, Buffer.from('{"probe":true}'), { 'content-type': 'application/json' }, '/v1beta/models/x:generateContent?key=1', 'POST');
    assert.strictEqual(seen.url, '/v1beta/models/x:generateContent?key=1', 'bare origin must keep the inbound path and query');
    assert.strictEqual(seen.body, '{"probe":true}', 'body forwarded verbatim');

    // C. Non-2xx upstream responses are passed through untouched.
    const { server: errorServer, port: errorPort } = await listen((req, res) => {
        req.resume();
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '7' });
        res.end('{"error":{"message":"rate limited"}}');
    });
    const sinkError = new Sink();
    await passthrough.runPassthroughRequest(sinkError, { ...model, apiUrl: `http://127.0.0.1:${errorPort}/v1/raw` }, Buffer.from('{}'), {}, '/v1/internal', 'POST');
    assert.strictEqual(sinkError.statusCode, 429, 'error status passes through');
    assert.strictEqual(sinkError.headers['retry-after'], '7', 'error headers pass through');
    assert.strictEqual(sinkError.body.toString('utf8'), '{"error":{"message":"rate limited"}}', 'error body passes through');
    await close(errorServer);

    // D. Configuration errors stay local and do not reach the network.
    const sinkBad = new Sink();
    await passthrough.runPassthroughRequest(sinkBad, { ...model, apiUrl: 'ftp://example.com/x' }, Buffer.from('{}'), {}, '/x', 'POST');
    assert.strictEqual(sinkBad.statusCode, 400, 'invalid endpoint is rejected locally');

    // E. The translation layer is gone and the pass-through config is accepted.
    for (const removed of ['proxy/translators', 'proxy/registry.js', 'proxy/artifactMetadata.js', 'proxy/reasoningReplay.js']) {
        assert.ok(!fs.existsSync(path.join(PROXY_ROOT, removed)), `${removed} must be removed`);
    }
    assert.ok(PROVIDERS.some((preset) => preset.id === 'free-llm-api'), 'FreeLLMAPI preset must exist');
    assert.strictEqual(resolveApiFormat('free-llm-api'), 'passthrough', 'FreeLLMAPI resolves to pass-through');
    const validation = validateCustomModel({
        name: 'models/freellmapi-gpt',
        provider: 'free-llm-api',
        apiUrl: 'http://127.0.0.1:8080/v1/raw',
        apiFormat: 'passthrough',
        externalModelName: 'gpt-4o',
    });
    assert.strictEqual(validation.valid, true, `pass-through model config must validate: ${validation.error || ''}`);

    await close(server);
    console.log('PASS gateway pass-through: body/headers/query forwarded raw, response streamed untouched, no translation modules');
}

main().catch((error) => {
    console.error('FAIL gateway pass-through:', error && error.stack ? error.stack : error);
    process.exit(1);
});
