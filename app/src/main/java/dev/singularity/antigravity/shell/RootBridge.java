package dev.singularity.antigravity.shell;

import android.content.Context;

import java.io.File;

/**
 * Privileged root shell access through `su` (uid=0).
 */
public class RootBridge {

    private final RootLocator locator;
    private final RootExecutor executor;
    private Boolean cachedAvailable = null;

    public RootBridge(Context context) {
        this.locator = new RootLocator(context);
        this.executor = new RootExecutor(context);
    }

    public boolean isAvailable() {
        if (cachedAvailable != null) {
            return cachedAvailable;
        }
        // suBinary() probes each candidate with a real `su -c id` round-trip and
        // returns a path only when it actually yields uid=0. A bare "su" fallback
        // means no candidate granted root.
        File su = locator.suBinary();
        boolean ok = su != null
                && su.getAbsolutePath().indexOf('/') >= 0
                && su.canExecute();
        cachedAvailable = ok;
        if (!ok) {
            android.util.Log.w("RootBridge", "su unavailable: no candidate granted uid=0");
        }
        return ok;
    }

    /** Runs `cmd` as root via su. Returns combined stdout/stderr; errors are text. */
    public String exec(String cmd) {
        return executor.exec(cmd);
    }
}
