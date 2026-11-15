package dev.singularity.antigravity.oauth;

import android.content.Context;
import android.util.Log;

import dev.singularity.antigravity.util.SensitiveDataRedactor;

/**
 * OAuth is delegated to an external browser (Google blocks WebView login).
 * This is the thin facade over the matcher and custom tab launcher.
 */
public final class OAuthManager {

    private final AuthUrlMatcher matcher = new AuthUrlMatcher();
    private final CustomTabLauncher launcher = new CustomTabLauncher();

    /** True when the URL must leave the WebView and go to the system browser. */
    public boolean isAuthUrl(String url) {
        return matcher.isAuthUrl(url);
    }

    /**
     * Intercepts an auth URL. Returns true if it was handled (opened externally),
     * false if the WebView should load it normally.
     */
    public boolean intercept(Context context, String url) {
        boolean auth = matcher.isAuthUrl(url);
        Log.i(OAuthConstants.TAG, "intercept isAuthUrl=" + auth + " url="
                + SensitiveDataRedactor.safeUrl(url));
        if (!auth) {
            return false;
        }
        Log.i(OAuthConstants.TAG, "isAuthUrl matched -> external browser: "
                + SensitiveDataRedactor.safeUrl(url));
        return launcher.openInBrowser(context, url);
    }

    /** Opens the URL as a Chrome Custom Tab, falling back to any browser. */
    public boolean openInBrowser(Context context, String url) {
        return launcher.openInBrowser(context, url);
    }
}
