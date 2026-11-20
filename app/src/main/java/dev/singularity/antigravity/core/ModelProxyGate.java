package dev.singularity.antigravity.core;

import android.os.SystemClock;
import android.util.Log;

import java.net.InetSocketAddress;
import java.net.Socket;

/**
 * Gate between model_proxy and the core: language_server must never start
 * before the proxy is actually listening on 127.0.0.1:50996, otherwise the core
 * boots straight into "dial tcp 127.0.0.1:50996: connect: connection refused"
 * and the readiness probe expires.
 *
 * The check is a plain TCP connect with a short timeout, which is what the
 * core's HTTP client does; every attempt is bounded so a poll loop can never
 * stall. Timestamps come from {@link SystemClock#elapsedRealtime()} because the
 * wall clock is still being synced during a cold boot: it can jump forward
 * (making a fresh wait look like it already timed out) or backward (making a
 * wait look frozen forever).
 */
public final class ModelProxyGate {

    private static final String TAG = "ModelProxyGate";

    /** Port the model proxy is launched on (matches RuntimeManager --cloud_code_endpoint). */
    public static final int PROXY_PORT = 50996;
    /** Per-attempt connect timeout; kept short so one probe can never stall the poll. */
    public static final int CONNECT_TIMEOUT_MS = 250;

    /** False while the proxy is intentionally stopped, so the core is not blocked. */
    private static volatile boolean enabled = true;

    /**
     * True once this launch spawned (or deliberately adopted) the proxy it is
     * waiting for. A listener left behind by a previous session must not open
     * the gate: the core would start against a proxy that is about to be
     * replaced and lose every request made during the swap.
     */
    private static volatile boolean owned = false;

    private ModelProxyGate() {
    }

    public static void setEnabled(boolean value) {
        enabled = value;
    }

    public static boolean isEnabled() {
        return enabled;
    }

    /** Monotonic milliseconds since boot; immune to wall-clock changes. */
    public static long nowMs() {
        return SystemClock.elapsedRealtime();
    }

    public static void setOwned(boolean value) {
        owned = value;
    }

    /** True when the listener on the proxy port belongs to this launch. */
    public static boolean isOwned() {
        return owned;
    }

    /**
     * True when this launch's proxy is listening. The core gate waits for this
     * instead of a bare TCP connect so a stale listener cannot satisfy it.
     */
    public static boolean isReady() {
        return owned && isAccepting();
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
