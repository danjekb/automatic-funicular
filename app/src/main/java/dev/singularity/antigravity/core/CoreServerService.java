package dev.singularity.antigravity.core;

import android.app.Service;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import dev.singularity.antigravity.runtime.RuntimeManager;
import dev.singularity.antigravity.util.BootTrace;
import dev.singularity.antigravity.util.ProcessUtils;

import java.io.File;
import java.util.concurrent.TimeUnit;

/**
 * Foreground host for the patched core (language_server). Holds a wake lock,
 * streams the process log to files/logs/core.log, and publishes serverUrl once
 * ready.
 */
public final class CoreServerService extends Service {

    private static final String TAG = "CoreServer";

    private RuntimeManager runtime;
    private WakeLockHolder wakeLock;
    private OpenUrlWatcher openUrlWatcher;
    private CoreProcessSupervisor supervisor;
    private dev.singularity.antigravity.log.LogRingBuffer logBuffer;
    private dev.singularity.antigravity.gateway.SystemGatewayServer gatewayServer;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile boolean destroyed;
    private volatile boolean modelProxyEnabled;
    private Process modelProxyProcess;
    private Thread modelProxyThread;

    /** Port the local model proxy listens on; shared with the core launch gate. */
    private static final int PROXY_PORT = ModelProxyGate.PROXY_PORT;
    /** Path fragment identifying a model_proxy child in /proc/<pid>/cmdline. */
    private static final String PROXY_ENTRY_MARKER = "model_proxy/entry.js";
    /** Every model_proxy child appends its stdout/stderr here. */
    private static final String PROXY_STDOUT_LOG = "proxy.log";
    /** Grace period for a SIGTERM'd proxy child before it is killed outright. */
    private static final long PROXY_STOP_GRACE_MS = 1500;
    /** Marks the extracted proxy tree as matching this APK build. */
    private static final String PROXY_ASSET_MARKER = ".overlay-version";

    @Override
    public void onCreate() {
        super.onCreate();
        BootTrace.install(this);
        BootTrace.append("CoreServerService.onCreate");
        runtime = new RuntimeManager(this);
        logBuffer = new dev.singularity.antigravity.log.LogRingBuffer();
        gatewayServer = new dev.singularity.antigravity.gateway.SystemGatewayServer(this, logBuffer, dev.singularity.antigravity.BuildConfig.GATEWAY_PORT);
        gatewayServer.start();

        Log.i(TAG, "state paths: HOME=" + getFilesDir().getAbsolutePath()
                + " appData=" + runtime.getAppDataDir().getAbsolutePath()
                + " projects=" + runtime.getProjectsDir().getAbsolutePath()
                + " runtime=" + runtime.getRuntimeDir().getAbsolutePath());
        CoreRuntimeState.httpsPort = runtime.getHttpsPort();
        CoreRuntimeState.csrfToken = runtime.getCsrfToken();
        CoreRuntimeState.restarting = false;
        CoreRuntimeState.lastError = null;
        CoreRuntimeState.serverUrl = null;

        ForegroundNotification.start(this);
        wakeLock = new WakeLockHolder();
        wakeLock.acquire(this);

        openUrlWatcher = new OpenUrlWatcher(this);
        openUrlWatcher.start();

        startModelProxy();
        startBackgroundDaemon();

        supervisor = new CoreProcessSupervisor(this, runtime, openUrlWatcher, logBuffer,
                this::onSupervisorTerminated);
        supervisor.start();
    }

    private File findProxyEntry() {
        File f1 = new File(getFilesDir(), "usr/lib/model_proxy/entry.js");
        if (f1.isFile()) return f1;
        File f2 = new File(getFilesDir(), "model_proxy/entry.js");
        if (f2.isFile()) return f2;
        return null;
    }

    private File findNodeExecutable() {
        File usrNode = new File(getFilesDir(), "usr/bin/node");
        if (usrNode.canExecute()) return usrNode;
        File nodeWrapper = new File(getFilesDir(), "runtime/bin/node");
        if (nodeWrapper.canExecute()) return nodeWrapper;
        return null;
    }

    private void startModelProxy() {
        // A retry must own exactly one supervisor: stop a previous one (and its
        // child) before spawning a fresh model_proxy process.
        if (modelProxyThread != null && modelProxyThread.isAlive()) {
            stopModelProxy();
        }
        modelProxyEnabled = true;
        // The core supervisor blocks on this gate before launching language_server.
        ModelProxyGate.setEnabled(true);
        modelProxyThread = new Thread(() -> {
            File prefixDir = new File(getFilesDir(), "usr");
            File logsDir = new File(getFilesDir(), "logs");
            logsDir.mkdirs();
            File logFile = new File(logsDir, "model-proxy.log");
            File rawOutputLog = new File(logsDir, PROXY_STDOUT_LOG);
            File dataDir = new File(getFilesDir(), ".gemini/antigravity-app");
            dataDir.mkdirs();
            try {
                dataDir.setReadable(true, false);
                dataDir.setWritable(true, false);
                dataDir.setExecutable(true, false);
                File[] files = dataDir.listFiles();
                if (files != null) {
                    for (File f : files) {
                        f.setReadable(true, false);
                        f.setWritable(true, false);
                    }
                }
            } catch (Exception ignored) {}
            File tmpDir = new File(getFilesDir(), "usr/tmp");
            tmpDir.mkdirs();

            // Copying the whole proxy tree (node_modules included) on every start
            // kept node from being spawned for well over the 120s core gate on a
            // cold APK update: the copy ran synchronously before the spawn. Copy
            // only when this APK has not been extracted yet, then reuse it.
            File proxyRoot = new File(getFilesDir(), "usr/lib/model_proxy");
            long apkStamp = apkUpdateStamp();
            if (proxyAssetsUpToDate(proxyRoot, apkStamp)) {
                BootTrace.append("model_proxy assets up to date; skipping copy");
            } else {
                long copyStart = ModelProxyGate.nowMs();
                try {
                    dev.singularity.antigravity.util.AssetUnpacker.copyTree(
                            getAssets(), "env/overlay/lib/model_proxy", proxyRoot);
                    writeProxyAssetMarker(proxyRoot, apkStamp);
                    BootTrace.append("model_proxy assets copied in "
                            + (ModelProxyGate.nowMs() - copyStart) + "ms");
                } catch (Exception e) {
                    Log.w(TAG, "Failed to sync model_proxy from assets: " + e.getMessage());
                    BootTrace.append("model_proxy asset sync failed: " + e.getMessage());
                }
            }

            // Wait for env extraction and package seeding if starting on a clean install
            boolean found = false;
            for (int i = 0; i < 60 && !destroyed && modelProxyEnabled; i++) {
                if (findNodeExecutable() != null && findProxyEntry() != null) {
                    found = true;
                    break;
                }
                try {
                    Thread.sleep(1200);
                } catch (InterruptedException e) {
                    return;
                }
            }
            if (!found) {
                File node = findNodeExecutable();
                File entry = findProxyEntry();
                String missing = "node=" + (node != null ? node.getAbsolutePath() : "missing")
                        + " entry=" + (entry != null ? entry.getAbsolutePath() : "missing");
                Log.w(TAG, "model_proxy prerequisites still missing after 72s: " + missing);
                BootTrace.append("model_proxy prerequisites missing after 72s: " + missing);
            }

            while (!destroyed && modelProxyEnabled) {
                File nodeExe = findNodeExecutable();
                File proxyEntry = findProxyEntry();
                if (nodeExe == null || proxyEntry == null) {
                    Log.w(TAG, "node or model_proxy not found, sleeping 5s before retry");
                    BootTrace.append("model_proxy not spawned: node="
                            + (nodeExe != null ? nodeExe.getAbsolutePath() : "missing")
                            + " entry=" + (proxyEntry != null ? proxyEntry.getAbsolutePath() : "missing"));
                    try {
                        Thread.sleep(5000);
                    } catch (InterruptedException e) {
                        break;
                    }
                    continue;
                }

                try {
                    // A stale child from a previous session (or the node process
                    // behind an `su -c` wrapper, which destroy() cannot reach) still
                    // owns the port; the new proxy would exit with EADDRINUSE and
                    // never log READY. Clear them before every spawn.
                    killStaleModelProxyProcesses();
                    Log.i(TAG, "Starting local model adapter proxy on port " + PROXY_PORT + "...");
                    dev.singularity.antigravity.shell.RootBridge rootBridge =
                            new dev.singularity.antigravity.shell.RootBridge(CoreServerService.this);
                    boolean hasSu = rootBridge.isAvailable();

                    ProcessBuilder pb;
                    if (hasSu) {
                        String proxyCmd = "export HOME='" + getFilesDir().getAbsolutePath() + "' && " +
                                "export PREFIX='" + prefixDir.getAbsolutePath() + "' && " +
                                "export LD_LIBRARY_PATH='" + prefixDir.getAbsolutePath() + "/lib' && " +
                                "export OPENSSL_CONF='" + prefixDir.getAbsolutePath() + "/etc/tls/openssl.cnf' && " +
                                "export SSL_CERT_FILE='" + prefixDir.getAbsolutePath() + "/etc/tls/cert.pem' && " +
                                "export CURL_CA_BUNDLE='" + prefixDir.getAbsolutePath() + "/etc/tls/cert.pem' && " +
                                "exec '" + prefixDir.getAbsolutePath() + "/bin/node' '" + proxyEntry.getAbsolutePath() + "' " +
                                "--port " + PROXY_PORT + " --data-dir '" + dataDir.getAbsolutePath() + "' --log-file '" + logFile.getAbsolutePath() + "'";

                        pb = new ProcessBuilder("/system/bin/su", "-c", proxyCmd);
                        pb.environment().remove("LD_LIBRARY_PATH");
                    } else {
                        java.util.List<String> cmd = new java.util.ArrayList<>();
                        cmd.add(nodeExe.getAbsolutePath());
                        cmd.add(proxyEntry.getAbsolutePath());
                        cmd.add("--port");
                        cmd.add(String.valueOf(PROXY_PORT));
                        cmd.add("--data-dir");
                        cmd.add(dataDir.getAbsolutePath());
                        cmd.add("--log-file");
                        cmd.add(logFile.getAbsolutePath());

                        pb = new ProcessBuilder(cmd);
                        pb.environment().put("PREFIX", prefixDir.getAbsolutePath());
                        pb.environment().put("PATH", prefixDir.getAbsolutePath() + "/bin:" + System.getenv("PATH"));
                        pb.environment().put("HOME", getFilesDir().getAbsolutePath());
                        pb.environment().put("TMPDIR", tmpDir.getAbsolutePath());
                        pb.environment().put("TEMP", tmpDir.getAbsolutePath());
                        pb.environment().put("TMP", tmpDir.getAbsolutePath());
                        pb.environment().put("LD_LIBRARY_PATH", prefixDir.getAbsolutePath() + "/lib");
                        File opensslCnf = new File(prefixDir, "etc/tls/openssl.cnf");
                        if (opensslCnf.isFile()) {
                            pb.environment().put("OPENSSL_CONF", opensslCnf.getAbsolutePath());
                        }
                        File certPem = new File(prefixDir, "etc/tls/cert.pem");
                        if (certPem.isFile()) {
                            pb.environment().put("SSL_CERT_FILE", certPem.getAbsolutePath());
                        }
                    }
                    pb.directory(getFilesDir());
                    // Drain the child's stdout/stderr into a file: a pipe nobody reads
                    // fills up and blocks node forever, and native crash output would be
                    // lost. The proxy itself appends uncaughtException /
                    // unhandledRejection traces to model-proxy.log synchronously, so those
                    // survive even when stdout/stderr cannot be read.
                    pb.redirectErrorStream(true);
                    pb.redirectOutput(ProcessBuilder.Redirect.appendTo(rawOutputLog));

                    Process p = pb.start();
                    modelProxyProcess = p;
                    String spawned = "model_proxy spawned; stdout/stderr -> "
                            + rawOutputLog.getAbsolutePath();
                    Log.i(TAG, spawned);
                    BootTrace.append("model_proxy spawned (" + (hasSu ? "su -c" : "direct")
                            + "), stdout -> " + rawOutputLog.getAbsolutePath());
                    if (logBuffer != null) {
                        logBuffer.appendLine(spawned);
                    }

                    int exitCode = p.waitFor();
                    modelProxyProcess = null;

                    if (!modelProxyEnabled || destroyed) {
                        BootTrace.append("model_proxy stopped (exit code " + exitCode + ")");
                        break;
                    }

                    BootTrace.append("model_proxy exited code=" + exitCode
                            + "; restarting in 2s (see " + rawOutputLog.getAbsolutePath() + ")");
                    Log.w(TAG, "Model proxy terminated with exit code " + exitCode
                            + " (see " + logFile.getAbsolutePath() + " and "
                            + rawOutputLog.getAbsolutePath() + "). Restarting in 2s...");
                    Thread.sleep(2000);
                } catch (InterruptedException ie) {
                    // Stop requested while waiting on the child: never orphan it.
                    destroyModelProxyProcess();
                    break;
                } catch (Exception e) {
                    destroyModelProxyProcess();
                    Log.w(TAG, "Error in model proxy lifecycle: " + e.getMessage());
                    BootTrace.append("model_proxy lifecycle error: " + e.getMessage());
                    try {
                        Thread.sleep(3000);
                    } catch (InterruptedException ignored) {
                        break;
                    }
                }
            }
        }, "ModelProxySupervisor");
        modelProxyThread.start();
    }

    /** APK lastUpdateTime, or -1 when it cannot be read. */
    private long apkUpdateStamp() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime;
        } catch (Exception e) {
            return -1;
        }
    }

    private static boolean proxyAssetsUpToDate(File proxyRoot, long apkStamp) {
        if (apkStamp <= 0 || !new File(proxyRoot, "entry.js").isFile()) {
            return false;
        }
        File marker = new File(proxyRoot, PROXY_ASSET_MARKER);
        if (!marker.isFile()) {
            return false;
        }
        try {
            String recorded = dev.singularity.antigravity.util.IoUtil.readAll(
                    new java.io.FileInputStream(marker), "UTF-8").trim();
            return recorded.equals(String.valueOf(apkStamp));
        } catch (Exception e) {
            return false;
        }
    }

    private static void writeProxyAssetMarker(File proxyRoot, long apkStamp) {
        try {
            dev.singularity.antigravity.util.AtomicFileWriter.writeText(
                    new File(proxyRoot, PROXY_ASSET_MARKER), apkStamp + "\n");
        } catch (Exception e) {
            Log.w(TAG, "cannot write proxy asset marker: " + e.getMessage());
        }
    }

    private void startBackgroundDaemon() {
        new Thread(() -> {
            try {
                // Give runtime environment a brief moment to stabilize
                Thread.sleep(1500);
                File daemonBin = new File(getFilesDir(), "usr/bin/agy-daemon");
                if (daemonBin.canExecute()) {
                    Log.i(TAG, "Starting autonomous background daemon...");
                    String daemonCmd = "export HOME='" + getFilesDir().getAbsolutePath() + "' && " +
                            "export PREFIX='" + getFilesDir().getAbsolutePath() + "/usr' && " +
                            "export PATH='" + getFilesDir().getAbsolutePath() + "/usr/bin:/system/bin' && " +
                            "export LD_LIBRARY_PATH='" + getFilesDir().getAbsolutePath() + "/usr/lib' && " +
                            "exec '" + daemonBin.getAbsolutePath() + "' start";
                    ProcessBuilder pb = new ProcessBuilder("/system/bin/su", "-c", daemonCmd);
                    pb.directory(getFilesDir());
                    pb.environment().remove("LD_LIBRARY_PATH");
                    pb.start();
                }
            } catch (Exception e) {
                Log.w(TAG, "Failed to start agy-daemon: " + e.getMessage());
            }
        }, "AgyDaemonStarter").start();
    }

    private void stopBackgroundDaemon() {
        try {
            File daemonBin = new File(getFilesDir(), "usr/bin/agy-daemon");
            if (daemonBin.canExecute()) {
                Log.i(TAG, "Stopping autonomous background daemon...");
                ProcessBuilder pb = new ProcessBuilder(daemonBin.getAbsolutePath(), "stop");
                pb.directory(getFilesDir());
                pb.environment().put("PATH", getFilesDir().getAbsolutePath() + "/usr/bin:" + System.getenv("PATH"));
                pb.environment().put("HOME", getFilesDir().getAbsolutePath());
                Process p = pb.start();
                if (!p.waitFor(1500, TimeUnit.MILLISECONDS)) {
                    Log.w(TAG, "agy-daemon stop timed out after 1500ms; destroying forcibly");
                    p.destroyForcibly();
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to stop agy-daemon: " + e.getMessage());
        }
    }

    private void onSupervisorTerminated() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (destroyed) {
                    return;
                }
                CoreRuntimeState.serverUrl = null;
                CoreRuntimeState.restarting = false;
                if (CoreRuntimeState.lastError == null) {
                    CoreRuntimeState.lastError = "core supervisor stopped unexpectedly";
                }
                if (wakeLock != null) {
                    wakeLock.release();
                }
                if (runtime != null) {
                    runtime.stopNetworkMonitor();
                }
                if (openUrlWatcher != null) {
                    openUrlWatcher.stop();
                }
                ForegroundNotification.update(CoreServerService.this,
                        "Core stopped — open app to retry");
            }
        });
    }

    private void stopModelProxy() {
        // Release the core launch gate first: a stopped proxy must not block restarts.
        ModelProxyGate.setEnabled(false);
        modelProxyEnabled = false;
        Thread owner = modelProxyThread;
        modelProxyThread = null;
        if (owner != null) {
            owner.interrupt();
        }
        // Kill our child and anything else still holding the proxy port, so the
        // next start (retry, service recreation) can bind 50996 again.
        destroyModelProxyProcess();
        if (owner != null && owner != Thread.currentThread()) {
            try {
                owner.join(2000);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /**
     * Terminate our own proxy child (SIGTERM, then SIGKILL after a short grace)
     * and any orphaned model_proxy process left behind by a previous session.
     */
    private void destroyModelProxyProcess() {
        Process p = modelProxyProcess;
        modelProxyProcess = null;
        if (p != null) {
            try {
                p.destroy();
            } catch (Exception ignored) {
            }
            try {
                if (!p.waitFor(PROXY_STOP_GRACE_MS, TimeUnit.MILLISECONDS)) {
                    p.destroyForcibly();
                }
            } catch (InterruptedException ie) {
                try {
                    p.destroyForcibly();
                } catch (Exception ignored) {
                }
            } catch (Exception ignored) {
                try {
                    p.destroyForcibly();
                } catch (Exception ignoredToo) {
                }
            }
        }
        killStaleModelProxyProcesses();
    }

    /**
     * Kill every model_proxy process that is not ours: the node child behind an
     * `su -c` wrapper survives a destroy() of the wrapper, keeps port 50996 bound
     * and starves every later proxy. Detection walks /proc cmdlines (works for
     * our own uid) and is repeated through su (works for root-owned children).
     */
    private void killStaleModelProxyProcesses() {
        java.util.LinkedHashSet<Integer> pids = new java.util.LinkedHashSet<>();
        int myPid = android.os.Process.myPid();
        File[] entries = new File("/proc").listFiles();
        if (entries != null) {
            for (File entry : entries) {
                if (!entry.getName().matches("\\d+")) {
                    continue;
                }
                int pid;
                try {
                    pid = Integer.parseInt(entry.getName());
                } catch (NumberFormatException notAPid) {
                    continue;
                }
                if (pid == myPid) {
                    continue;
                }
                if (isModelProxyCmdline(readCmdline(new File(entry, "cmdline")))) {
                    pids.add(pid);
                }
            }
        }
        for (int pid : pids) {
            Log.w(TAG, "Terminating stale model_proxy process (PID " + pid + ")");
            try {
                android.os.Process.sendSignal(pid, android.os.Process.SIGNAL_KILL);
            } catch (Exception ignored) {
            }
            try {
                new dev.singularity.antigravity.shell.RootBridge(this)
                        .exec("kill -9 " + pid + " 2>/dev/null");
            } catch (Exception ignored) {
            }
        }
        // Root-owned children are invisible to the app-side /proc scan. Only ask
        // su when the port is still bound, so the common path never pays for it.
        if (ModelProxyGate.isAccepting()) {
            // The [m] trick keeps the shell running this command from matching
            // its own cmdline.
            try {
                dev.singularity.antigravity.shell.RootBridge bridge =
                        new dev.singularity.antigravity.shell.RootBridge(this);
                if (bridge.isAvailable()) {
                    bridge.exec("for p in /proc/[0-9]*; do "
                            + "if tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q '[m]odel_proxy/entry.js'; then "
                            + "kill -9 ${p#/proc/} 2>/dev/null; fi; done; true");
                }
            } catch (Exception ignored) {
            }
        }
        long deadline = ModelProxyGate.nowMs() + 3000;
        while (ModelProxyGate.nowMs() < deadline) {
            if (!ModelProxyGate.isAccepting()) {
                return;
            }
            ProcessUtils.sleep(100);
        }
        Log.w(TAG, "model_proxy port " + PROXY_PORT + " still accepting after stale-process cleanup");
    }

    private static String readCmdline(File cmdlineFile) {
        if (!cmdlineFile.canRead()) {
            return "";
        }
        try (java.io.FileInputStream in = new java.io.FileInputStream(cmdlineFile)) {
            byte[] buf = new byte[1024];
            int n = in.read(buf);
            if (n <= 0) {
                return "";
            }
            return new String(buf, 0, n).replace('\u0000', ' ');
        } catch (Exception ignored) {
            return "";
        }
    }

    private static boolean isModelProxyCmdline(String cmdline) {
        if (cmdline == null || cmdline.isEmpty()) {
            return false;
        }
        if (cmdline.contains(PROXY_ENTRY_MARKER)) {
            return true;
        }
        // Overlay/non-standard install paths: entry.js started on the proxy port.
        return cmdline.contains("entry.js") && cmdline.contains(String.valueOf(PROXY_PORT));
    }

    @Override
    public void onDestroy() {
        stopBackgroundDaemon();
        stopModelProxy();
        if (gatewayServer != null) {
            gatewayServer.stop();
        }
        destroyed = true;
        mainHandler.removeCallbacksAndMessages(null);
        // Intentional stop: the watchdog must not treat the exit as a crash.
        if (supervisor != null) {
            supervisor.stop();
        }
        if (openUrlWatcher != null) {
            openUrlWatcher.stop();
        }
        if (wakeLock != null) {
            wakeLock.release();
        }
        if (runtime != null) {
            runtime.stopNetworkMonitor();
        }
        CoreRuntimeState.serverUrl = null;
        CoreRuntimeState.lastError = null;
        CoreRuntimeState.restarting = false;
        super.onDestroy();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
