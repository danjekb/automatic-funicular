"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openBrowser = openBrowser;
const node_child_process_1 = require("node:child_process");
/** Dependency-light so opening a browser never starts proxy timers in a CLI process. */
async function openBrowser(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Invalid browser URL');

    // Notify Android CoreProcessSupervisor and OpenUrlWatcher via stream
    console.log(`ANTIGRAVITY_OPEN_URL: ${url.href}`);
    console.log(`AGY_OPEN_URL=${url.href}`);

    // Direct launch on Android via su / am / intent
    if (process.platform === 'linux') {
        try {
            (0, node_child_process_1.exec)(`su -c "/system/bin/am start -a android.intent.action.VIEW -d '${url.href}'" 2>/dev/null || /system/bin/am broadcast -a dev.singularity.antigravity.ACTION_OPEN_URL -p dev.singularity.antigravity --es url '${url.href}' 2>/dev/null || xdg-open '${url.href}' 2>/dev/null`, { timeout: 3000 });
            return;
        } catch {
            // fallback to spawn
        }
    }

    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
    await new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}
//# sourceMappingURL=browserLauncher.js.map