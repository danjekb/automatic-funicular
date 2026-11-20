package dev.singularity.antigravity.install;

import android.content.Context;
import android.util.Log;

import dev.singularity.antigravity.util.BootTrace;
import dev.singularity.antigravity.util.FileModeUtil;

import java.io.File;
import java.util.concurrent.TimeUnit;

/**
 * Locates the node runtime for the model proxy and installs it when the prefix
 * lost it.
 *
 * node is not bundled in the APK: it only arrives with the {@code nodejs} seed
 * package from the Termux repository. A prefix that was reinstalled (fresh env
 * install after an APK update) therefore starts without node, and the seed
 * installer used to consider {@code bin/nodejs} the marker, which never exists,
 * so it retried on a six-hour backoff while the proxy stayed down. This class
 * gives the proxy a single, self-healing entry point: find node anywhere it can
 * legitimately live, repair the exec bit, and otherwise install the package
 * once, synchronously, with the attempt logged.
 */
public final class NodeProvisioner {

    private static final String TAG = "NodeProvisioner";
    /** Termux nodejs ships bin/node, not bin/nodejs. Order matters. */
    private static final String[] CANDIDATES = {
            "usr/bin/node",
            "usr/bin/nodejs",
            "runtime/bin/node",
    };
    private static final String INSTALL_LOG = "node-install.log";
    private static final long INSTALL_TIMEOUT_MS = 120000;

    private NodeProvisioner() {
    }

    /** Executable node, or null when the prefix does not have one. */
    public static File find(Context context) {
        File files = context.getFilesDir();
        for (String rel : CANDIDATES) {
            File candidate = new File(files, rel);
            if (!candidate.isFile()) {
                continue;
            }
            if (candidate.canExecute()) {
                return candidate;
            }
            // A package installed by a different uid (su -c pkg install) can land
            // without the exec bit for the app; repair it instead of reporting
            // the runtime as missing.
            FileModeUtil.setExec(candidate);
            if (candidate.canExecute()) {
                BootTrace.append("node exec bit repaired: " + candidate.getAbsolutePath());
                return candidate;
            }
            BootTrace.append("node found without exec bit: " + candidate.getAbsolutePath());
        }
        return null;
    }

    /**
     * Returns an executable node, installing the nodejs seed package once when
     * the prefix has none. Blocking; call it off the main thread.
     */
    public static File ensure(Context context) {
        File node = find(context);
        if (node != null) {
            return node;
        }
        File prefix = EnvPaths.prefix(context);
        File pkg = new File(prefix, "bin/pkg");
        if (!pkg.isFile()) {
            BootTrace.append("node provisioning skipped: pkg wrapper missing at " + pkg);
            return null;
        }
        File logFile = new File(new File(context.getFilesDir(), "logs"), INSTALL_LOG);
        try {
            File logDir = logFile.getParentFile();
            if (logDir != null) {
                logDir.mkdirs();
            }
            BootTrace.append("node missing; running pkg install nodejs (log: "
                    + logFile.getAbsolutePath() + ")");
            boolean ok = runPkg(context, prefix, logFile, "install", "-y", "nodejs");
            node = find(context);
            if (node == null && ok) {
                // Installed but not visible yet (unpacked asynchronously by pkg).
                for (int i = 0; i < 10 && node == null; i++) {
                    ProcessUtilsCompat.sleep(500);
                    node = find(context);
                }
            }
            if (node != null) {
                BootTrace.append("node provisioned: " + node.getAbsolutePath());
            } else {
                BootTrace.append("node provisioning failed; see " + logFile.getAbsolutePath());
            }
            return node;
        } catch (Exception e) {
            Log.w(TAG, "node provisioning error: " + e.getMessage());
            BootTrace.append("node provisioning error: " + e.getMessage());
            return null;
        }
    }

    private static boolean runPkg(Context context, File prefix, File logFile, String... args) {
        java.util.List<String> command = new java.util.ArrayList<>();
        command.add(new File(prefix, "bin/pkg").getAbsolutePath());
        for (String arg : args) {
            command.add(arg);
        }
        Process process = null;
        try {
            File home = new File(context.getFilesDir(), "home");
            File tmp = new File(prefix, "tmp");
            home.mkdirs();
            tmp.mkdirs();
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.directory(context.getFilesDir());
            builder.redirectErrorStream(true);
            builder.redirectOutput(ProcessBuilder.Redirect.appendTo(logFile));
            builder.environment().put("PREFIX", prefix.getAbsolutePath());
            builder.environment().put("HOME", home.getAbsolutePath());
            builder.environment().put("TMPDIR", tmp.getAbsolutePath());
            builder.environment().put("PATH", new File(prefix, "bin").getAbsolutePath() + ":/system/bin");
            builder.environment().put("LD_LIBRARY_PATH", new File(prefix, "lib").getAbsolutePath());
            File preload = new File(prefix, "lib/libtermux-exec.so");
            if (preload.isFile()) {
                builder.environment().put("LD_PRELOAD", preload.getAbsolutePath());
            }
            File cert = new File(prefix, "etc/tls/cert.pem");
            if (cert.isFile()) {
                builder.environment().put("SSL_CERT_FILE", cert.getAbsolutePath());
                builder.environment().put("CURL_CA_BUNDLE", cert.getAbsolutePath());
            }
            builder.environment().put("AGY_APPLICATION_ID", context.getPackageName());
            builder.environment().put("LANG", "C.UTF-8");
            process = builder.start();
            if (!process.waitFor(INSTALL_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                process.destroyForcibly();
                BootTrace.append("pkg install nodejs timed out after " + INSTALL_TIMEOUT_MS + "ms");
                return false;
            }
            int exit = process.exitValue();
            BootTrace.append("pkg install nodejs exit=" + exit);
            return exit == 0;
        } catch (Exception e) {
            if (process != null) {
                process.destroyForcibly();
            }
            BootTrace.append("pkg install nodejs error: " + e.getMessage());
            return false;
        }
    }

    /** Sleep without pulling in a dependency on the core process utilities. */
    private static final class ProcessUtilsCompat {
        static void sleep(long ms) {
            try {
                Thread.sleep(ms);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }
}
