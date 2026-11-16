package dev.singularity.antigravity.shell;

import android.content.Context;
import java.io.File;

/** Locates privileged su execution binary. */
public final class RishLocator {

    private final RootLocator rootLocator;

    public RishLocator(Context context) {
        this.rootLocator = new RootLocator(context);
    }

    public File rishBinary() {
        return rootLocator.suBinary();
    }
}
