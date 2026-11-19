package dev.singularity.antigravity.util;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.Charset;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Append-only startup timeline in files/logs/boot.log.
 *
 * <p>A phone that is not attached to a computer has no logcat, so every startup
 * milestone (service, model proxy, core gate, core ready, asset load, page
 * load, JS console, crash) is written to one file the user can export. This is
 * the only way to tell "the core never became ready" apart from "the core is
 * ready but the WebView painted nothing" after the fact.</p>
 */
public final class BootTrace {

    private static final String TAG = "BootTrace";
    private static final String FILE_NAME = "logs/boot.log";
    /** Rotate once at this size so the file stays attachable. */
    private static final long MAX_BYTES = 256 * 1024;

    private static volatile Context appContext;

    private BootTrace() {
    }

    /** Stores the application context used by the no-context overload. */
    public static void install(Context context) {
        if (context != null) {
            appContext = context.getApplicationContext();
        }
    }

    public static void append(Context context, String message) {
        install(context);
        append(message);
    }

    public static synchronized void append(String message) {
        Context context = appContext;
        if (context == null || message == null) {
            return;
        }
        String line = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.US)
                .format(new Date())
                + " " + SensitiveDataRedactor.redactLine(message);
        Log.i(TAG, line);
        try {
            File logFile = new File(context.getFilesDir(), FILE_NAME);
            File dir = logFile.getParentFile();
            if (dir != null) {
                dir.mkdirs();
            }
            if (logFile.isFile() && logFile.length() > MAX_BYTES) {
                File previous = new File(dir, "boot.log.1");
                if (previous.isFile()) {
                    previous.delete();
                }
                logFile.renameTo(previous);
            }
            try (FileOutputStream out = new FileOutputStream(logFile, true)) {
                out.write((line + "\n").getBytes(Charset.forName("UTF-8")));
            }
        } catch (Exception e) {
            Log.w(TAG, "cannot append boot trace: " + e.getMessage());
        }
    }
}
