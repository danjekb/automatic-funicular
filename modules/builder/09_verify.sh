#!/usr/bin/env bash
# 09_verify.sh - Verifies APK signature integrity using jarsigner.
set -euo pipefail

export PATH="/data/user/0/com.agyru.t2/files/usr/lib/jvm/java-17-openjdk/bin:/data/user/0/com.agyru.t2/files/logiapki/automatic-funicular/automatic-funicular-main/env/overlay/bin:$PATH"

APK="${1:-${DIST_DIR:-dist}/singularity.apk}"

echo "[*] [09_verify] Verifying APK signature..."
[ -f "$APK" ] || { echo "Error: APK not found: $APK" >&2; exit 1; }

jarsigner -verify -verbose "$APK"
echo "[SUCCESS] [09_verify] APK verification PASSED: $APK"
