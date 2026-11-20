/**
 * core/namespace.js - bridge.core bundle scope.
 *
 * Runs first in the bridge.core.js IIFE. Declares the shared scope every other
 * core fragment attaches to: `global`, `CONFIG`, `VERSION`, `warn`, `log`, plus
 * idempotency guard. Window globals stay compatible with the original
 * (`window.__agBridgeCore` is the public API, `window.__AG_BRIDGE_CORE__` the
 * guard).
 */
'use strict';

var AG = (window.__agCore = window.__agCore || {});

if (window.__AG_BRIDGE_CORE__) return;
window.__AG_BRIDGE_CORE__ = true;

var global = window;
var VERSION = '1.0.0';

// Live config: filled by config.js, then kept in sync by csrf.js/endpoints.js.
var CONFIG = window.__APP_CONFIG__ || {};

function warn(where, err) {
  try {
    console.warn('[AGY bridge.core] ' + where + ':', err && err.message ? err.message : err);
  } catch (e) {}
}

// Informational equivalent of warn(); fragments call it without guarding
// console, which is absent in some embedded WebViews.
function log(message) {
  try {
    console.log('[AGY bridge.core] ' + message);
  } catch (e) {}
}
