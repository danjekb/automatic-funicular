#!/usr/bin/env bash
# gen_keys.sh - Creates the fork's separate release signing key.
#
# The key material is written to <repo>/keys/ which is git-ignored. Back it up
# privately: losing it means future updates cannot be installed over existing
# installs (Android refuses an update signed by a different key).
#
# Usage:
#   bash tools/gen_keys.sh [--force]
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYS_DIR="$PROJECT_ROOT/keys"
KS="$KEYS_DIR/singularity-release.jks"
PROPS="$KEYS_DIR/keystore.properties"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

KEYTOOL="$(command -v keytool 2>/dev/null || true)"
if [ -z "$KEYTOOL" ]; then
    for candidate in \
        "$(dirname "$(readlink -f "$(which java 2>/dev/null || echo /dev/null)")" 2>/dev/null)/keytool" \
        ${PREFIX:-/data/user/0/com.agy.dev/files/usr}/lib/jvm/java-*/bin/keytool \
        /usr/lib/jvm/java-*/bin/keytool; do
        if [ -x "$candidate" ]; then
            KEYTOOL="$candidate"
            break
        fi
    done
fi

if [ -z "$KEYTOOL" ] || [ ! -x "$KEYTOOL" ]; then
    echo "[ERROR] keytool not found; install a JDK 17+ and re-run." >&2
    exit 1
fi

mkdir -p "$KEYS_DIR"
chmod 700 "$KEYS_DIR"

if [ -f "$KS" ] && [ "$FORCE" -ne 1 ]; then
    echo "[OK] Release keystore already exists: $KS"
    exit 0
fi

STORE_PASS="$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')"
KEY_PASS="$STORE_PASS"

"$KEYTOOL" -genkeypair -v \
    -keystore "$KS" \
    -storetype PKCS12 \
    -alias singularity \
    -keyalg RSA -keysize 4096 -validity 10000 \
    -storepass "$STORE_PASS" -keypass "$KEY_PASS" \
    -dname "CN=Singularity for Android, O=Singularity Fork, C=US"

cat > "$PROPS" <<EOF
# Singularity release signing material — DO NOT COMMIT.
# This file and the keystore next to it are git-ignored.
keyAlias=singularity
keyPassword=$KEY_PASS
storePassword=$STORE_PASS
EOF

chmod 600 "$KS" "$PROPS"
echo "[OK] Generated $KS"
echo "[OK] Wrote $PROPS"
echo
echo "Fingerprint:"
"$KEYTOOL" -list -v -keystore "$KS" -alias singularity -storepass "$STORE_PASS" 2>/dev/null \
    | grep -E "SHA256:|SHA1:" || true
