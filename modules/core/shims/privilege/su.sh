#!/system/bin/sh
# Singularity root shell wrapper (su uid=0)
unset LD_PRELOAD LD_LIBRARY_PATH

for p in /system/bin/su /system/xbin/su /sbin/su /system/sbin/su /data/adb/ksu/bin/su /data/adb/ap/bin/su /su/bin/su /magisk/.core/bin/su; do
  if [ -x "$p" ]; then
    exec "$p" "$@"
  fi
done

if command -v su >/dev/null 2>&1; then
  exec su "$@"
fi

echo "su: root binary not found on device" >&2
exit 1
