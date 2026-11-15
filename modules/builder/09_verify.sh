#!/usr/bin/env bash
# 09_verify.sh - Verifies APK signature integrity using jarsigner.
set -euo pipefail

APK="${1:-${DIST_DIR:-dist}/singularity.apk}"

echo "[*] [09_verify] Verifying APK signature..."
[ -f "$APK" ] || { echo "Error: APK not found: $APK" >&2; exit 1; }

jarsigner -verify -verbose "$APK"
echo "[SUCCESS] [09_verify] APK verification PASSED: $APK"
