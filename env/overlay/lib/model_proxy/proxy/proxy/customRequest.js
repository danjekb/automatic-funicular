"use strict";
/**
 * Custom model transport.
 *
 * All schema, message and tool-call translation was removed: the configured
 * endpoint (FreeLLMAPI and friends) performs format translation upstream, so
 * this module is a thin alias for the raw pass-through implementation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const passthrough = require("./passthrough");
exports.getProxyMetrics = passthrough.getProxyMetrics;
exports.stopCustomRequests = passthrough.stopCustomRequests;
exports.buildFallbackChain = passthrough.buildFallbackChain;
exports.runCustomModelRequest = passthrough.runCustomModelRequest;
exports.runPassthroughRequest = passthrough.runPassthroughRequest;
//# sourceMappingURL=customRequest.js.map
