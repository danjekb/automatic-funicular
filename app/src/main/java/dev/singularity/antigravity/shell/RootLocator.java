package dev.singularity.antigravity.shell;

import android.content.Context;
import java.io.File;

/** Locates the su binary on Android. */
public final class RootLocator {

    private final Context appContext;

    public RootLocator(Context context) {
        this.appContext = context.getApplicationContext();
    }

    /** Finds an executable su binary or fallback candidate. */
    public File suBinary() {
        File files = appContext.getFilesDir();
        File[] candidates = new File[]{
                new File("/system/bin/su"),
                new File("/system/xbin/su"),
                new File("/sbin/su"),
                new File("/system/sbin/su"),
                new File("/data/adb/ksu/bin/su"),
                new File("/data/adb/ap/bin/su"),
                new File(files, "usr/bin/su"),
                new File(files, "runtime/bin/su"),
                new File(files, "bin/su")
        };
        for (File candidate : candidates) {
            if (candidate.exists() && candidate.canExecute()) {
                return candidate;
            }
        }
        return candidates[0];
    }
}
