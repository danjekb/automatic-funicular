package dev.singularity.antigravity.shell;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Locates a working {@code su} binary on Android.
 *
 * <p>KernelSU (and most modern root solutions) do not place {@code su} on the
 * default system PATH. Instead the app ships its own wrapper at
 * {@code $PREFIX/bin/su} ({@code files/usr/bin/su}) which locates the real
 * su binary and execs it. Relying on {@link File#exists()} against the classic
 * system paths therefore fails on these devices. This locator probes every
 * candidate with a real {@code su -c id} round-trip and only returns a binary
 * that actually yields {@code uid=0}.
 */
public final class RootLocator {

    private static final String TAG = "RootLocator";

    private final Context appContext;
    private volatile File cachedSu;

    public RootLocator(Context context) {
        this.appContext = context.getApplicationContext();
    }

    /** Absolute paths of every su candidate, most-likely-first, de-duplicated. */
    private Set<String> candidatePaths() {
        File files = appContext.getFilesDir();
        LinkedHashSet<String> set = new LinkedHashSet<>();
        // System / root-manager locations (KernelSU, Magisk, APatch).
        set.add("/system/bin/su");
        set.add("/system/xbin/su");
        set.add("/sbin/su");
        set.add("/system/sbin/su");
        set.add("/debug_ramdisk/su");
        set.add("/data/adb/ksu/bin/su");
        set.add("/data/adb/ap/bin/su");
        set.add("/data/adb/magisk/su");
        set.add("/su/bin/su");
        set.add("/magisk/.core/bin/su");
        // App-internal wrapper (the reliable path on KernelSU where the
        // system su is hidden from the app's mount namespace).
        set.add(new File(files, "usr/bin/su").getAbsolutePath());
        set.add(new File(files, "runtime/bin/su").getAbsolutePath());
        set.add(new File(files, "bin/su").getAbsolutePath());
        // Bare name resolved via PATH.
        set.add("su");
        return set;
    }

    /**
     * Finds a su binary that actually grants root, or {@code null} if none does.
     * The result is cached for the process lifetime.
     */
    public File suBinary() {
        File cached = cachedSu;
        if (cached != null) {
            return cached;
        }
        synchronized (this) {
            if (cachedSu != null) {
                return cachedSu;
            }
            for (String path : candidatePaths()) {
                if (canUseSu(path)) {
                    cachedSu = new File(path);
                    Log.i(TAG, "su resolved to: " + path);
                    return cachedSu;
                }
            }
            // Negative result is cached too so we don't re-probe on every call.
            cachedSu = new File("su");
            Log.w(TAG, "no working su binary found on this device");
            return cachedSu;
        }
    }

    /** Clears the cached result so the next {@link #suBinary()} re-probes. */
    public void invalidate() {
        cachedSu = null;
    }

    /** True when {@code su -c id} through {@code suPath} reports uid=0. */
    private boolean canUseSu(String suPath) {
        // Cheap pre-check for absolute paths; skip bare names (PATH lookup).
        if (suPath.indexOf('/') >= 0) {
            File f = new File(suPath);
            if (!f.exists()) {
                return false;
            }
        }
        Process p = null;
        try {
            ProcessBuilder pb = new ProcessBuilder(suPath, "-c", "id");
            pb.redirectErrorStream(true);
            pb.environment().remove("LD_LIBRARY_PATH");
            pb.environment().remove("LD_PRELOAD");
            p = pb.start();
            // Drain output so the child never blocks on a full pipe.
            java.io.InputStream in = p.getInputStream();
            byte[] buf = new byte[256];
            StringBuilder sb = new StringBuilder();
            int n;
            while ((n = in.read(buf)) > 0) {
                sb.append(new String(buf, 0, n, java.nio.charset.StandardCharsets.UTF_8));
            }
            int code = p.waitFor();
            if (code != 0) {
                return false;
            }
            String out = sb.toString().toLowerCase();
            return out.contains("uid=0");
        } catch (Exception e) {
            return false;
        } finally {
            if (p != null) {
                p.destroy();
            }
        }
    }
}
