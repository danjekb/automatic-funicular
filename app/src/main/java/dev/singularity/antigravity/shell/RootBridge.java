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
        File su = locator.suBinary();
        if (su != null && su.exists() && su.canExecute()) {
            cachedAvailable = true;
            return true;
        }
        try {
            Process p = new ProcessBuilder("su", "-c", "id").start();
            int code = p.waitFor();
            cachedAvailable = (code == 0);
            return cachedAvailable;
        } catch (Exception e) {
            cachedAvailable = false;
            return false;
        }
    }

    /** Runs `cmd` as root via su. Returns combined stdout/stderr; errors are text. */
    public String exec(String cmd) {
        return executor.exec(cmd);
    }
}
