#!/usr/bin/env bash
# build.sh - Convenient root wrapper for Singularity APK builder.
# Usage:
#   bash build.sh                 # Build standard release edition (dist/singularity.apk)
#   bash build.sh --dev           # Build debuggable dev edition (dist/singularity-dev.apk)
#   bash build.sh --fast          # Fast uncompressed assets iteration

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The model proxy is a raw pass-through: no translation/schema-conversion modules
# may be reintroduced by an upstream sync, because the endpoint translates.
PROXY_TRANSLATION_DIR="$SCRIPT_DIR/env/overlay/lib/model_proxy/proxy/proxy/translators"
if [ -d "$PROXY_TRANSLATION_DIR" ]; then
    echo "[ERROR] Gateway translation modules found at $PROXY_TRANSLATION_DIR." >&2
    echo "        Custom models must pass through untranslated (see README_GATEWAY.md)." >&2
    exit 1
fi

for stale in registry artifactMetadata reasoningReplay; do
    if [ -f "$SCRIPT_DIR/env/overlay/lib/model_proxy/proxy/proxy/$stale.js" ]; then
        echo "[ERROR] Stale gateway translation module: proxy/proxy/$stale.js" >&2
        exit 1
    fi
done

exec bash "$SCRIPT_DIR/modules/builder/build_apk.sh" "$@"
