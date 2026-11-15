package dev.singularity.antigravity.shell;

import android.content.Context;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.util.Map;

/** Runs a privileged shell command through su (root uid=0). */
public final class RootExecutor {

    private final Context appContext;
    private final RootLocator locator;

    public RootExecutor(Context context) {
        this.appContext = context.getApplicationContext();
        this.locator = new RootLocator(context);
    }

    /** Runs `cmd` as root via su. Returns combined stdout/stderr; errors are text. */
    public String exec(String cmd) {
        if (cmd == null || cmd.trim().isEmpty()) {
            return "error: empty command";
        }
        File su = locator.suBinary();
        String suPath = (su != null && su.canExecute()) ? su.getAbsolutePath() : "su";

        ProcessBuilder pb = new ProcessBuilder(
                suPath,
                "-c",
                cmd);
        pb.redirectErrorStream(true);
        Map<String, String> env = pb.environment();
        env.remove("LD_LIBRARY_PATH");
        pb.directory(appContext.getFilesDir());
        Process process = null;
        try {
            process = pb.start();
            StringBuilder out = new StringBuilder();
            BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
            String line;
            while ((line = reader.readLine()) != null) {
                out.append(line).append('\n');
            }
            int code = process.waitFor();
            String text = out.toString().trim();
            if (code != 0 && text.isEmpty()) {
                return "error: su exited " + code;
            }
            return text;
        } catch (Exception e) {
            return "error: " + e.getMessage();
        } finally {
            if (process != null) {
                process.destroy();
            }
        }
    }
}
