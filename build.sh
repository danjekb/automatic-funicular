#!/usr/bin/env bash
# build.sh - Convenient root wrapper for Singularity APK builder.
# Usage:
#   bash build.sh                 # Build standard release edition (dist/singularity.apk)
#   bash build.sh --dev           # Build debuggable dev edition (dist/singularity-dev.apk)
#   bash build.sh --fast          # Fast uncompressed assets iteration

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/modules/builder/build_apk.sh" "$@"
