#!/usr/bin/env bash
# run_all.sh - Gateway pass-through tests (no Android runtime required).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[gateway] Verifying raw HTTP/SSE pass-through and translation-layer removal..."
node "$SCRIPT_DIR/passthrough_test.js"
