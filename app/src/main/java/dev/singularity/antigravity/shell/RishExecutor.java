package dev.singularity.antigravity.shell;

import android.content.Context;

/** Runs a privileged shell command through root su. */
public final class RishExecutor {

    private final RootExecutor rootExecutor;

    public RishExecutor(Context context) {
        this.rootExecutor = new RootExecutor(context);
    }

    public String exec(String cmd) {
        return rootExecutor.exec(cmd);
    }
}
