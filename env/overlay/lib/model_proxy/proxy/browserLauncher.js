"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openBrowser = openBrowser;
const node_child_process_1 = require("node:child_process");
/** Dependency-light so opening a browser never starts proxy timers in a CLI process. */
async function openBrowser(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Invalid browser URL');

    // Notify Android CoreProcessSupervisor and OpenUrlWatcher via stdout
    console.log(`ANTIGRAVITY_OPEN_URL: ${url.href}`);
    console.log(`AGY_OPEN_URL=${url.href}`);

    // Direct launch on Android using spawn with su or /system/bin/sh without relying on non-existent /bin/sh
    if (process.platform === 'linux') {
        try {
            const suChild = (0, node_child_process_1.spawn)('su', ['-c', `/system/bin/am start -a android.intent.action.VIEW -d "${url.href}"`], { detached: true, stdio: 'ignore' });
            suChild.unref();
            return;
        } catch {
            // fallback
        }

        try {
            const shChild = (0, node_child_process_1.spawn)('/system/bin/sh', ['-c', `/system/bin/am broadcast -a dev.singularity.antigravity.ACTION_OPEN_URL -p dev.singularity.antigravity --es url "${url.href}"`], { detached: true, stdio: 'ignore' });
            shChild.unref();
            return;
        } catch {
            // fallback
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