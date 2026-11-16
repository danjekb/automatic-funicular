package dev.singularity.antigravity.shell;

import android.content.Context;

/**
 * Root access bridge. Formerly Shizuku/rish, now backed directly by `su` (uid=0).
 */
public final class ShizukuBridge extends RootBridge {

    public ShizukuBridge(Context context) {
        super(context);
    }
}
