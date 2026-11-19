package dev.singularity.antigravity.core;

import android.util.Log;

import java.net.InetSocketAddress;
import java.net.Socket;

/**
 * Gate between model_proxy and the core: language_server must never start
 * before the proxy is actually listening on 127.0.0.1:50996, otherwise the core
 * boots straight into "dial tcp 127.0.0.1:50996: connect: connection refused"
 * and the 60s readiness probe expires.
 *
 * The check is a plain TCP connect, which is what the core's HTTP client does.
 * A half-initialised proxy that merely bound the port is still accepted by the
 * kernel, exactly like it would be for the core.
 */
public final class ModelProxyGate {

    private static final String TAG = "ModelProxyGate";

    /** Port the model proxy is launched on (matches RuntimeManager --cloud_code_endpoint). */
    public static final int PROXY_PORT = 50996;
    /** Socket connect timeout for one probe; kept short so polling stays responsive. */
    private static final int CONNECT_TIMEOUT_MS = 400;

    /** False while the proxy is intentionally stopped, so the core is not blocked. */
    private static volatile boolean enabled = true;

    private ModelProxyGate() {
    }

    public static void setEnabled(boolean value) {
        enabled = value;
    }

    public static boolean isEnabled() {
        return enabled;
    }

    /** True when a TCP connection to the proxy port is accepted right now. */
    public static boolean isAccepting() {
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress("127.0.0.1", PROXY_PORT), CONNECT_TIMEOUT_MS);
            return true;
        } catch (Exception notListening) {
            return false;
        } finally {
            try {
                socket.close();
            } catch (Exception ignored) {
            }
        }
    }

    /** One probe plus a short log message, used by diagnostics. */
    public static boolean probeAndLog() {
        boolean accepting = isAccepting();
        Log.i(TAG, "model_proxy on 127.0.0.1:" + PROXY_PORT + (accepting ? " accepting" : " not accepting"));
        return accepting;
    }
}
