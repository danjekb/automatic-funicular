"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GOOGLE_NATIVE_SCOPES = void 0;
exports.resolveGoogleNativeClient = resolveGoogleNativeClient;
/** Read a public desktop OAuth profile from liblanguage_server.so or recognized local vendor installation. */
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const SUPPORTED_COMMIT = 'ecfbad74d93962fc8ca485d93ab9b4f3d4cb6cf8';
const MODULE_MARKER = '"out-build/vs/platform/cloudCode/common/oauthClient.js"(){"use strict";';
exports.GOOGLE_NATIVE_SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
];
const UNAVAILABLE = 'A supported Antigravity IDE installation (2.5.5) is required for Antigravity sign-in. ' +
    'For a portable installation, set ANTIGRAVITY_IDE_RESOURCES to its resources directory and restart the service, ' +
    'or use Custom Desktop OAuth.';

function extractOAuthFromLibrary(filePath) {
    if (!filePath) return null;
    try {
        if (!fs.existsSync(filePath)) return null;
        let fd;
        try {
            fd = fs.openSync(filePath, 'r');
            const stat = fs.fstatSync(fd);
            const CHUNK_SIZE = 4 * 1024 * 1024;
            const chunk = Buffer.alloc(CHUNK_SIZE);
            let offset = 0;
            let clientId = null;
            let clientSecret = null;
            while (offset < stat.size) {
                const bytesRead = fs.readSync(fd, chunk, 0, CHUNK_SIZE, offset);
                if (bytesRead <= 0) break;
                const str = chunk.toString('latin1', 0, bytesRead);
                if (!clientId) {
                    const idMatches = str.match(/([0-9]{12,}-[a-z0-9]+\.apps\.googleusercontent\.com)/g);
                    if (idMatches && idMatches.length > 0) {
                        clientId = idMatches.find(id => id.startsWith('1071006060591')) || idMatches[0];
                    }
                }
                if (!clientSecret) {
                    const secMatches = str.match(/(GOCSPX-[A-Za-z0-9_-]{28})/g);
                    if (secMatches && secMatches.length > 0) {
                        clientSecret = secMatches[0];
                    }
                }
                if (clientId && clientSecret) break;
                offset += bytesRead - 512;
            }
            if (clientId) {
                return {
                    clientId,
                    clientSecret: clientSecret || '',
                    scopes: exports.GOOGLE_NATIVE_SCOPES,
                };
            }
        } finally {
            if (fd !== undefined) {
                try { fs.closeSync(fd); } catch {}
            }
        }
    } catch {}
    return null;
}

function readFile(filename, maximum) {
    const resolved = path.resolve(filename);
    let current = path.parse(resolved).root;
    for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink())
            throw new Error(UNAVAILABLE);
    }
    const handle = fs.openSync(resolved, 'r');
    try {
        const stat = fs.fstatSync(handle);
        if (!stat.isFile() || stat.size > maximum)
            throw new Error(UNAVAILABLE);
        const value = fs.readFileSync(handle, 'utf8');
        if (Buffer.byteLength(value) > maximum)
            throw new Error(UNAVAILABLE);
        return value;
    }
    finally {
        fs.closeSync(handle);
    }
}

function inspect(app) {
    const pkg = JSON.parse(readFile(path.join(app, 'package.json'), 256 * 1024));
    const product = JSON.parse(readFile(path.join(app, 'product.json'), 1024 * 1024));
    const extension = JSON.parse(readFile(path.join(app, 'extensions/antigravity/package.json'), 1024 * 1024));
    if (pkg.name !== 'Antigravity IDE' ||
        pkg.version !== '1.107.0' ||
        pkg.author?.name !== 'Google' ||
        pkg.main !== './out/main.js' ||
        product.nameShort !== 'Antigravity IDE' ||
        product.applicationName !== 'antigravity-ide' ||
        product.ideVersion !== '2.5.5' ||
        product.commit !== SUPPORTED_COMMIT ||
        extension.name !== 'antigravity' ||
        extension.publisher !== 'google' ||
        extension.main !== './dist/extension.js')
        throw new Error(UNAVAILABLE);
    const source = readFile(path.join(app, 'out/main.js'), 64 * 1024 * 1024);
    const start = source.indexOf(MODULE_MARKER);
    if (start < 0 || source.indexOf(MODULE_MARKER, start + MODULE_MARKER.length) !== -1)
        throw new Error(UNAVAILABLE);
    const end = source.indexOf('}})', start);
    if (end < 0 || end - start > 8192)
        throw new Error(UNAVAILABLE);
    const body = source.slice(start + MODULE_MARKER.length, end);
    const profile = /^([\w$]+)="([A-Za-z0-9_.-]+\.apps\.googleusercontent\.com)",([\w$]+)="(GOCSPX-[A-Za-z0-9_-]+)",([\w$]+)="([A-Za-z0-9_.-]+\.apps\.googleusercontent\.com)",([\w$]+)="(GOCSPX-[A-Za-z0-9_-]+)",([\w$]+)=(\[[^\]]+\])$/.exec(body);
    if (!profile)
        throw new Error(UNAVAILABLE);
    const [, personalId, clientId, personalSecret, clientSecret, gcpId, , gcpSecret, , scopeVariable, rawScopes] = profile;
    const scopes = JSON.parse(rawScopes);
    if (!Array.isArray(scopes) ||
        JSON.stringify(scopes) !== JSON.stringify(exports.GOOGLE_NATIVE_SCOPES) ||
        clientId.length > 512 ||
        clientSecret.length > 2048 ||
        new Set([personalId, personalSecret, gcpId, gcpSecret, scopeVariable]).size !== 5)
        throw new Error(UNAVAILABLE);
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const selection = `${escape(gcpId)}:${escape(personalId)},[\\w$]+=[\\w$]+\\?${escape(gcpSecret)}:${escape(personalSecret)}`;
    if (!new RegExp(`getLoginUrl\\([\\w$]+\\)\\{[^}]{0,500}${selection}`).test(source) ||
        !new RegExp(`exchangeCodeForToken\\([^)]*\\)\\{[^}]{0,500}${selection}`).test(source) ||
        !source.includes(`scope:${scopeVariable},state:`) ||
        !source.includes('.generateAuthUrl({access_type:"offline",') ||
        !source.includes('getLocalhostRedirectUri(){return this._port===null?null:`http://localhost:${this._port}/oauth-callback`}'))
        throw new Error(UNAVAILABLE);
    return { clientId, clientSecret, scopes: scopes };
}

function resolveGoogleNativeClient(options = {}) {
    const env = options.env || process.env;
    const platform = options.platform || process.platform;
    const home = options.home || os.homedir();
    const explicit = options.resources || env.ANTIGRAVITY_IDE_RESOURCES;
    const runtime = options.runtimeResources ?? process.resourcesPath;

    // 1. Try reading directly from liblanguage_server.so (Android runtime & build assets)
    const candidateLibs = [
        options.liblanguageServerPath,
        env.LIBLANGUAGE_SERVER_PATH,
        path.join(home, 'runtime/bin/liblanguage_server.so'),
        path.join(process.env.HOME || '', 'runtime/bin/liblanguage_server.so'),
        '/data/user/0/dev.singularity.antigravity/files/runtime/bin/liblanguage_server.so',
        '/data/user/0/com.agy.dev/files/runtime/bin/liblanguage_server.so',
        '/data/user/0/com.agy/files/runtime/bin/liblanguage_server.so',
        path.resolve(__dirname, '../../../../runtime/bin/liblanguage_server.so'),
        path.resolve(__dirname, '../../../../../build/staging/assets/runtime/bin/liblanguage_server.so'),
    ].filter(Boolean);

    for (const libPath of candidateLibs) {
        const result = extractOAuthFromLibrary(libPath);
        if (result) {
            return result;
        }
    }

    // 2. Try desktop Electron installation paths if present
    const roots = explicit
        ? [path.resolve(explicit)]
        : [
            ...(runtime ? [runtime] : []),
            ...(platform === 'win32'
                ? [
                    path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Programs/Antigravity IDE'),
                    path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Programs/Antigravity'),
                    ...(env.ProgramFiles
                        ? [path.join(env.ProgramFiles, 'Antigravity IDE'), path.join(env.ProgramFiles, 'Antigravity')]
                        : []),
                ]
                : platform === 'darwin'
                    ? [
                        '/Applications/Antigravity IDE.app',
                        '/Applications/Antigravity.app',
                        path.join(home, 'Applications/Antigravity IDE.app'),
                        path.join(home, 'Applications/Antigravity.app'),
                    ]
                    : [
                        '/opt/antigravity',
                        '/usr/share/antigravity',
                        '/usr/lib/antigravity',
                        '/usr/local/lib/antigravity',
                        path.join(home, '.local/share/antigravity-ide'),
                    ]),
        ];
    for (const root of roots) {
        for (const app of [
            path.join(root, 'app'),
            path.join(root, 'resources/app'),
            path.join(root, 'Contents/Resources/app'),
            root,
        ]) {
            try {
                return inspect(app);
            }
            catch {
                /* Try other recognized install layouts without exposing vendor contents or paths. */
            }
        }
    }

    throw new Error(UNAVAILABLE);
}
//# sourceMappingURL=googleNativeClient.js.map