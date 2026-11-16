#!/usr/bin/env bash
# 08_sign.sh - Signs the aligned APK with the fork's own keystore.
#
# Key resolution order (never committed to git):
#   1. $CONTINUUM_KEYSTORE / $AGY_RELEASE_KEYSTORE (+ alias/passwords)
#   2. <repo>/keys/continuum-release.jks with keys/keystore.properties
#   3. tools/debug.keystore (public AOSP debug key) — local iteration only
#
# Release builds MUST use (1) or (2); a CI release without a release key fails
# closed instead of publishing an APK signed with a public key.
set -euo pipefail

export PATH="/data/user/0/com.agyru.t2/files/usr/lib/jvm/java-17-openjdk/bin:/data/user/0/com.agyru.t2/files/logiapki/automatic-funicular/automatic-funicular-main/env/overlay/bin:$PATH"

ALIGNED_APK="${1:-$BUILD_DIR/aligned.apk}"
OUT_APK="${2:-$DIST_DIR/singularity.apk}"

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
KEYS_DIR="$PROJECT_ROOT/keys"
DEFAULT_RELEASE_KS="$KEYS_DIR/singularity-release.jks"
[ ! -f "$DEFAULT_RELEASE_KS" ] && [ -f "$KEYS_DIR/continuum-release.jks" ] && DEFAULT_RELEASE_KS="$KEYS_DIR/continuum-release.jks"
PROPS="$KEYS_DIR/keystore.properties"

KEYSTORE="${SINGULARITY_KEYSTORE:-${CONTINUUM_KEYSTORE:-${AGY_RELEASE_KEYSTORE:-}}}"
KEY_ALIAS="${SINGULARITY_KEY_ALIAS:-${CONTINUUM_KEY_ALIAS:-${AGY_RELEASE_KEY_ALIAS:-}}}"
KEY_PASS="${SINGULARITY_KEY_PASS:-${CONTINUUM_KEY_PASS:-${AGY_RELEASE_KEY_PASS:-}}}"
STORE_PASS="${SINGULARITY_STORE_PASS:-${CONTINUUM_STORE_PASS:-${AGY_RELEASE_STORE_PASS:-}}}"
SOURCE="environment"

if [ -z "$KEYSTORE" ] && [ -f "$DEFAULT_RELEASE_KS" ]; then
    KEYSTORE="$DEFAULT_RELEASE_KS"
    KEY_ALIAS="${KEY_ALIAS:-singularity}"
    SOURCE="$DEFAULT_RELEASE_KS"
    if [ -f "$PROPS" ]; then
        [ -z "$KEY_ALIAS" ] && KEY_ALIAS="$(sed -n 's/^keyAlias=//p' "$PROPS" | head -n1)"
        [ -z "$KEY_PASS" ] && KEY_PASS="$(sed -n 's/^keyPassword=//p' "$PROPS" | head -n1)"
        [ -z "$STORE_PASS" ] && STORE_PASS="$(sed -n 's/^storePassword=//p' "$PROPS" | head -n1)"
    fi
fi

if [ -z "$KEYSTORE" ]; then
    # DEV_MODE=1: explicit local dev build. ALLOW_DEBUG_SIGNING=1: CI test build
    # when no release key secret is configured (never used for a published
    # release, and the package id stays the release id).
    if [ "${DEV_MODE:-0}" = "1" ] || [ "${ALLOW_DEBUG_SIGNING:-0}" = "1" ]; then
        KEYSTORE="$PROJECT_ROOT/tools/debug.keystore"
        KEY_ALIAS="androiddebugkey"
        KEY_PASS="android"
        STORE_PASS="android"
        SOURCE="tools/debug.keystore (public AOSP key)"
    else
        echo "[ERROR] No release signing key configured." >&2
        echo "        Generate one with: bash tools/gen_keys.sh" >&2
        echo "        (keys/ is git-ignored; never commit a private key)" >&2
        exit 3
    fi
fi

if [ ! -f "$KEYSTORE" ]; then
    echo "[ERROR] Keystore not found: $KEYSTORE" >&2
    exit 3
fi

case "$SOURCE" in
    tools/debug.keystore*)
        echo "[WARN] Signing with the PUBLIC AOSP debug key ($SOURCE)." >&2
        echo "[WARN] This build is for local testing only and cannot be published." >&2
        ;;
    *)
        echo "[*] [08_sign] Signing with fork keystore: $KEYSTORE"
        ;;
esac

echo "[*] [08_sign] Signing APK with jarsigner..."
mkdir -p "$(dirname "$OUT_APK")"

jarsigner \
    -keystore "$KEYSTORE" \
    -storepass "$STORE_PASS" \
    -keypass "$KEY_PASS" \
    -signedjar "$OUT_APK" \
    "$ALIGNED_APK" \
    "$KEY_ALIAS"

echo "[OK] [08_sign] Signed APK created: $OUT_APK ($(stat -c%s "$OUT_APK") bytes)"
