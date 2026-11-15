#!/data/user/0/dev.singularity.antigravity/files/usr/bin/sh
unset LD_LIBRARY_PATH LD_PRELOAD

for p in /debug_ramdisk/su /sbin/su /system/sbin/su /system/bin/su /system/xbin/su /su/bin/su /magisk/.core/bin/su /data/adb/ksu/bin/su /data/adb/ap/bin/su; do
	if [ -x "$p" ]; then
		PATH=/debug_ramdisk:/sbin:/sbin/su:/su/bin:/su/xbin:/system/bin:/system/xbin exec "$p" "$@"
	fi
done

if command -v su >/dev/null 2>&1; then
	exec su "$@"
fi

echo "su: root binary not found on device" >&2
exit 1
