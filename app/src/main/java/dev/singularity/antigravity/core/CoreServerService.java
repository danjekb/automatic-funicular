package dev.singularity.antigravity.core;

import android.app.Service;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import dev.singularity.antigravity.runtime.RuntimeManager;

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

    @Override
    public void onCreate() {
        super.onCreate();
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
        modelProxyEnabled = true;
        modelProxyThread = new Thread(() -> {
            File prefixDir = new File(getFilesDir(), "usr");
            File logsDir = new File(getFilesDir(), "logs");
            logsDir.mkdirs();
            File logFile = new File(logsDir, "model-proxy.log");
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

            // Wait for env extraction and package seeding if starting on a clean install
            for (int i = 0; i < 60 && !destroyed && modelProxyEnabled; i++) {
                if (findNodeExecutable() != null && findProxyEntry() != null) {
                    break;
                }
                try {
                    Thread.sleep(1200);
                } catch (InterruptedException e) {
                    return;
                }
            }

            while (!destroyed && modelProxyEnabled) {
                File nodeExe = findNodeExecutable();
                File proxyEntry = findProxyEntry();
                if (nodeExe == null || proxyEntry == null) {
                    Log.w(TAG, "node or model_proxy not found, sleeping 5s before retry");
                    try {
                        Thread.sleep(5000);
                    } catch (InterruptedException e) {
                        break;
                    }
                    continue;
                }

                try {
                    Log.i(TAG, "Starting local model adapter proxy on port 50996...");
                    java.util.List<String> cmd = new java.util.ArrayList<>();
                    cmd.add(nodeExe.getAbsolutePath());
                    cmd.add(proxyEntry.getAbsolutePath());
                    cmd.add("--port");
                    cmd.add("50996");
                    cmd.add("--data-dir");
                    cmd.add(dataDir.getAbsolutePath());
                    cmd.add("--log-file");
                    cmd.add(logFile.getAbsolutePath());

                    ProcessBuilder pb = new ProcessBuilder(cmd);
                    pb.directory(getFilesDir());
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

                    Process p = pb.start();
                    modelProxyProcess = p;

                    int exitCode = p.waitFor();
                    modelProxyProcess = null;

                    if (!modelProxyEnabled || destroyed) {
                        break;
                    }

                    Log.w(TAG, "Model proxy terminated with exit code " + exitCode + ". Restarting in 2s...");
                    Thread.sleep(2000);
                } catch (InterruptedException ie) {
                    break;
                } catch (Exception e) {
                    Log.w(TAG, "Error in model proxy lifecycle: " + e.getMessage());
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

    private void startBackgroundDaemon() {
        new Thread(() -> {
            try {
                // Give runtime environment a brief moment to stabilize
                Thread.sleep(1500);
                File daemonBin = new File(getFilesDir(), "usr/bin/agy-daemon");
                if (daemonBin.canExecute()) {
                    Log.i(TAG, "Starting autonomous background daemon...");
                    ProcessBuilder pb = new ProcessBuilder(daemonBin.getAbsolutePath(), "start");
                    pb.directory(getFilesDir());
                    pb.environment().put("PATH", getFilesDir().getAbsolutePath() + "/usr/bin:" + System.getenv("PATH"));
                    pb.environment().put("HOME", getFilesDir().getAbsolutePath());
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
        modelProxyEnabled = false;
        if (modelProxyThread != null) {
            modelProxyThread.interrupt();
        }
        if (modelProxyProcess != null) {
            try {
                modelProxyProcess.destroy();
            } catch (Exception ignored) {
            }
        }
        try {
            File stateFile = new File(getFilesDir(), ".gemini/antigravity-app/.ide-proxy/state.json");
            if (stateFile.isFile()) {
                String content = new String(java.nio.file.Files.readAllBytes(stateFile.toPath()));
                org.json.JSONObject obj = new org.json.JSONObject(content);
                int pid = obj.optInt("pid", 0);
                if (pid > 0) {
                    Log.i(TAG, "Terminating model proxy PID " + pid);
                    android.os.Process.sendSignal(pid, 15);
                }
            }
        } catch (Exception ignored) {
        }
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
