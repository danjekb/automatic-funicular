#!/system/bin/sh
# Singularity privileged shell wrapper: routes through su for full root access
BASEDIR="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)"
if [ -x "$BASEDIR/su" ]; then
  exec "$BASEDIR/su" "$@"
fi

unset LD_PRELOAD LD_LIBRARY_PATH
for p in /system/bin/su /system/xbin/su /sbin/su /system/sbin/su /data/adb/ksu/bin/su /data/adb/ap/bin/su; do
  if [ -x "$p" ]; then
    exec "$p" "$@"
  fi
done

if command -v su >/dev/null 2>&1; then
  exec su "$@"
fi

echo "rish: root binary (su) not found on device" >&2
exit 1
