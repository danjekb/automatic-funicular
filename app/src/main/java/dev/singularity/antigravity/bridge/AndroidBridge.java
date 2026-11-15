package dev.singularity.antigravity.bridge;

import android.content.Context;
import android.webkit.JavascriptInterface;

import dev.singularity.antigravity.runtime.RuntimeManager;
import dev.singularity.antigravity.shell.ShizukuBridge;
import dev.singularity.antigravity.theme.ThemeManager;
import dev.singularity.antigravity.ui.MainActivity;

import java.lang.ref.WeakReference;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.security.SecureRandom;

/**
 * Minimal, low-privilege JavaScript bridge for the app UI. It is visible to
 * embedded frames, so shell, notification, and arbitrary URL capabilities must
 * not be exposed here. Native-only getters below are intentionally unannotated.
 */
public final class AndroidBridge {

    private final Context appContext;
    private final UiBridge ui = new UiBridge();
    private final ThemeBridge themeBridge;
    private final EngineBridge engine;
    private final EngineConfigJson config;
    private final dev.singularity.antigravity.core.SubagentManager subagents;
    private final String blobBridgeToken = createBlobBridgeToken();
    private volatile WeakReference<MainActivity> activityRef;

    public AndroidBridge(Context context, RuntimeManager runtime,
                         ShizukuBridge shizuku, ThemeManager theme) {
        this.appContext = context.getApplicationContext();
        this.themeBridge = new ThemeBridge(theme);
        this.engine = new EngineBridge(runtime);
        this.config = new EngineConfigJson(appContext, runtime, engine, shizuku, themeBridge);
        this.subagents = new dev.singularity.antigravity.core.SubagentManager(appContext);
    }

    /** Host activity, used to dismiss the native splash once the UI has painted. */
    public void setActivity(MainActivity activity) {
        this.activityRef = activity != null ? new WeakReference<MainActivity>(activity) : null;
        ui.setActivity(activity);
    }

    @JavascriptInterface
    public void onUiReady(String token) {
        if (matchesNativeBridgeToken(token)) {
            ui.onUiReady();
        }
    }

    @JavascriptInterface
    public void openDirectoryPicker() {
        final MainActivity act = activityRef != null ? activityRef.get() : MainActivity.activeActivity;
        if (act != null) {
            act.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    act.launchDirectoryPicker();
                }
            });
        }
    }

    @JavascriptInterface
    public void onUiError(String token, final String errorMessage) {
        if (matchesNativeBridgeToken(token)) {
            ui.onUiError(errorMessage);
        }
    }

    @JavascriptInterface
    public boolean setTheme(String mode) {
        return themeBridge.setTheme(mode);
    }

    @JavascriptInterface
    public boolean setThemeByUser(final String mode) {
        return themeBridge.setThemeByUser(mode);
    }

    @JavascriptInterface
    public void onVisualThemeChanged(String visual) {
        themeBridge.onVisualThemeChanged(visual);
    }

    @JavascriptInterface
    public String getTheme() {
        return themeBridge.getTheme();
    }

    @JavascriptInterface
    public boolean isAmoled() {
        return themeBridge.isAmoled();
    }

    @JavascriptInterface
    public boolean isDesktopMode() {
        return ui.isDesktopMode();
    }

    @JavascriptInterface
    public void setDesktopMode(boolean enabled) {
        ui.setDesktopMode(enabled);
    }

    @JavascriptInterface
    public String getModelManagerUrl() {
        return EngineConfigJson.readModelManagerUrl(appContext);
    }

    @JavascriptInterface
    public void openModelManager() {
        final String url = getModelManagerUrl();
        final MainActivity act = activityRef != null ? activityRef.get() : MainActivity.activeActivity;
        if (act != null) {
            act.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        android.content.Intent intent = new android.content.Intent(
                                android.content.Intent.ACTION_VIEW,
                                android.net.Uri.parse(url));
                        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                        act.startActivity(intent);
                    } catch (Exception e) {
                        android.util.Log.w("AndroidBridge", "Failed to open model manager: " + e.getMessage());
                    }
                }
            });
        }
    }

    // Native-only helpers used while preparing the trusted app document.
    public boolean isEngineReady() {
        return engine.isReady();
    }

    public int getEnginePort() {
        return engine.getPort();
    }

    public String getEngineBaseUrl() {
        return engine.getBaseUrl();
    }

    public String getCsrfToken() {
        return engine.getCsrfToken();
    }

    public String getConfig() {
        return config.get();
    }

    /** Native-only token inserted into the trusted top-level document. */
    public String getBlobBridgeToken() {
        return blobBridgeToken;
    }

    /** Saves a downloaded blob only for scripts holding the top-level document token. */
    @JavascriptInterface
    public void saveBlob(String token, String base64Data, String filename, String mimeType) {
        if (!matchesNativeBridgeToken(token)) {
            return;
        }
        final MainActivity act = activityRef != null ? activityRef.get() : MainActivity.activeActivity;
        if (act != null) {
            dev.singularity.antigravity.ui.download.FileDownloader.handleBlobData(
                    act, base64Data, filename, mimeType);
        }
    }

    private boolean matchesNativeBridgeToken(String candidate) {
        if (candidate == null) {
            return false;
        }
        try {
            byte[] expected = blobBridgeToken.getBytes(Charset.forName("UTF-8"));
            byte[] actual = candidate.getBytes(Charset.forName("UTF-8"));
            return MessageDigest.isEqual(expected, actual);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String createBlobBridgeToken() {
        byte[] random = new byte[32];
        new SecureRandom().nextBytes(random);
        char[] hex = "0123456789abcdef".toCharArray();
        char[] encoded = new char[random.length * 2];
        for (int i = 0; i < random.length; i++) {
            int value = random[i] & 0xff;
            encoded[i * 2] = hex[value >>> 4];
            encoded[i * 2 + 1] = hex[value & 0x0f];
        }
        return new String(encoded);
    }

    /* ------------------------------------------------------------- subagents */

    @JavascriptInterface
    public String subagentListTypes() {
        try {
            org.json.JSONArray arr = new org.json.JSONArray();
            for (dev.singularity.antigravity.core.SubagentManager.SubagentType t : subagents.listTypes()) {
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("id", t.id);
                o.put("name", t.nameEn);
                o.put("namePl", t.namePl);
                o.put("prompt", t.promptEn);
                o.put("promptPl", t.promptPl);
                arr.put(o);
            }
            return arr.toString();
        } catch (Exception e) {
            android.util.Log.w("AndroidBridge", "subagentListTypes failed", e);
            return "[]";
        }
    }

    @JavascriptInterface
    public String subagentCreate(String typeId) {
        try {
            String id = subagents.createInstance(typeId);
            return id != null ? id : "";
        } catch (Exception e) {
            android.util.Log.w("AndroidBridge", "subagentCreate failed", e);
            return "";
        }
    }

    @JavascriptInterface
    public String subagentListInstances() {
        try {
            org.json.JSONArray arr = new org.json.JSONArray();
            for (dev.singularity.antigravity.core.SubagentManager.SubagentInstance i : subagents.listInstances()) {
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("id", i.id);
                o.put("typeId", i.type.id);
                o.put("typeName", i.type.nameEn);
                o.put("createdAt", i.createdAt);
                o.put("messageCount", i.messageCount);
                arr.put(o);
            }
            return arr.toString();
        } catch (Exception e) {
            android.util.Log.w("AndroidBridge", "subagentListInstances failed", e);
            return "[]";
        }
    }

    @JavascriptInterface
    public String subagentSendMessage(String agentId, String message) {
        try {
            dev.singularity.antigravity.core.SubagentManager.SubagentResponse resp = subagents.sendMessage(agentId, message);
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("success", resp.success);
            o.put("content", resp.content != null ? resp.content : "");
            o.put("error", resp.error != null ? resp.error : "");
            return o.toString();
        } catch (Exception e) {
            android.util.Log.w("AndroidBridge", "subagentSendMessage failed", e);
            try {
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("success", false);
                o.put("content", "");
                o.put("error", e.getMessage());
                return o.toString();
            } catch (Exception ee) {
                return "{\"success\":false,\"content\":\"\",\"error\":\"unknown\"}";
            }
        }
    }

    @JavascriptInterface
    public boolean subagentTerminate(String agentId) {
        try {
            return subagents.terminateInstance(agentId);
        } catch (Exception e) {
            android.util.Log.w("AndroidBridge", "subagentTerminate failed", e);
            return false;
        }
    }
}
