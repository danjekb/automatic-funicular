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
exports.NATIVE_MODEL_CAPACITY = void 0;
exports.legacyPlaceholderId = legacyPlaceholderId;
exports.placeholderIndex = placeholderIndex;
exports.allocateModelIdentities = allocateModelIdentities;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const modelCatalog_1 = require("./proxy/modelCatalog");
/** Verified against the Antigravity IDE 2.5.5 Model enum: M0..M650 = 1000..1650. */
exports.NATIVE_MODEL_CAPACITY = 651;
/**
 * Placeholders that the bundled language_server 2.11.0 maps to a model profile
 * (`models` / `model_profiles` in its embedded config). A placeholder outside
 * this set has no profile, so an agent turn serializes a message budget of 0
 * and dies with "maxMessageTokens must be positive, got 0".
 */
const PROFILE_BACKED_PLACEHOLDERS = [
    15, 16, 18, 20, 26, 35, 36, 37, 47, 50, 71, 72, 73, 78, 84, 124, 125, 132, 133, 148, 149,
    186, 187, 196, 198, 261, 262, 269, 270, 271, 289, 291, 292, 298, 299, 300, 301, 318, 319,
    320, 322, 400, 401, 402, 403, 404, 405, 408, 409, 410, 411, 412, 413,
];
function isProfileBacked(index) {
    return PROFILE_BACKED_PLACEHOLDERS.includes(index);
}
function hash(value) {
    let result = 5381;
    for (let i = 0; i < value.length; i++)
        result = ((result << 5) + result + value.charCodeAt(i)) | 0;
    return Math.abs(result);
}
function legacyPlaceholderId(model) {
    return `MODEL_PLACEHOLDER_M${400 + (hash((model.displayName || model.name || 'custom-model').toLowerCase()) % 200)}`;
}
function placeholderIndex(value) {
    const index = typeof value === 'number'
        ? value - 1000
        : typeof value === 'string' && /^MODEL_PLACEHOLDER_M\d+$/.test(value)
            ? Number(value.slice('MODEL_PLACEHOLDER_M'.length))
            : undefined;
    return Number.isInteger(index) && index >= 0 && index < exports.NATIVE_MODEL_CAPACITY ? index : undefined;
}
function upstreamPlaceholders(upstream) {
    if (!upstream || typeof upstream !== 'object')
        return [];
    const result = new Set();
    for (const key of ['models', 'availableModels', 'available_models']) {
        const collection = upstream[key];
        if (!collection || typeof collection !== 'object')
            continue;
        for (const entry of Object.values(collection)) {
            if (!entry || typeof entry !== 'object')
                continue;
            const index = placeholderIndex(entry.model);
            if (index !== undefined)
                result.add(index);
        }
    }
    return [...result];
}
function loadState(filename) {
    try {
        const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (raw?.version !== 1 ||
            !raw.assignments ||
            typeof raw.assignments !== 'object' ||
            Array.isArray(raw.assignments) ||
            !Array.isArray(raw.reserved))
            throw new Error('Invalid native model identity metadata');
        const entries = Object.entries(raw.assignments);
        const valid = (value) => Number.isInteger(value) && Number(value) >= 0 && Number(value) < exports.NATIVE_MODEL_CAPACITY;
        if (entries.some(([name, value]) => !name || !valid(value)) || raw.reserved.some((value) => !valid(value)))
            throw new Error('Invalid native model identity allocation');
        if (new Set(entries.map(([, value]) => value)).size !== entries.length)
            throw new Error('Duplicate native model identity allocation');
        return {
            version: 1,
            assignments: Object.fromEntries(entries),
            reserved: [...new Set(raw.reserved)],
        };
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { version: 1, assignments: {}, reserved: [] };
        throw error;
    }
}
/**
 * Persist enum ownership independently of model ordering, display labels and secrets.
 * Removed models retain their assignment so cached IDE selections never select a different model.
 * Native enum reservations survive offline catalog fallback; a newly observed native owner wins.
 */
function allocateModelIdentities(dataDirectory, models, upstream) {
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const lockfile = path.join(dataDirectory, 'custom_model_identities.lock');
    const owner = JSON.stringify({ pid: process.pid, token: (0, node_crypto_1.randomUUID)() });
    let lock;
    try {
        lock = fs.openSync(lockfile, 'wx', 0o600);
    }
    catch (error) {
        if (error.code === 'EEXIST') {
            let stoppedPid;
            try {
                const { pid } = JSON.parse(fs.readFileSync(lockfile, 'utf8'));
                if (Number.isInteger(pid) && pid > 0) {
                    try {
                        process.kill(pid, 0);
                    }
                    catch (failure) {
                        if (failure.code === 'ESRCH')
                            stoppedPid = pid;
                    }
                }
            }
            catch {
                /* A live owner may not have written its PID yet; never steal its lock. */
            }
            if (stoppedPid !== undefined)
                throw new Error(`Native model identity lock remains from stopped process ${stoppedPid}. Close Antigravity and proxy processes, remove only ${lockfile}, then retry. Preserve custom_model_identities.json.`);
            throw new Error('Native model identities are being updated by another process; retry after it finishes');
        }
        throw error;
    }
    try {
        fs.writeFileSync(lock, owner);
        return allocateLocked(dataDirectory, models, upstream);
    }
    finally {
        fs.closeSync(lock);
        if (fs.readFileSync(lockfile, 'utf8') === owner)
            fs.unlinkSync(lockfile);
    }
}
function allocateLocked(dataDirectory, models, upstream) {
    const filename = path.join(dataDirectory, 'custom_model_identities.json');
    const state = loadState(filename);
    const before = JSON.stringify(state);
    const reserved = new Set([...state.reserved, ...upstreamPlaceholders(upstream)]);
    const assignments = new Map(Object.entries(state.assignments));
    // A Google catalog can start using an enum that was free at installation time.
    // Retire our old ownership instead of ever routing that native selection to a custom provider.
    for (const [name, index] of assignments)
        if (reserved.has(index))
            assignments.delete(name);
    // An assignment without an engine profile cannot run a single agent turn.
    // Release it so the model is reallocated into a working placeholder.
    for (const [name, index] of assignments)
        if (!isProfileBacked(index))
            assignments.delete(name);
    const used = new Set([...reserved, ...assignments.values()]);
    const unique = new Map(models.map((model) => [model.name, model]));
    if (unique.size !== models.length)
        throw new Error('Duplicate saved model names cannot have distinct native identities');
    const ordered = [...unique.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Hand the profile-backed slots out first; only a full pool falls back to
    // placeholders the engine may not know.
    for (const model of ordered) {
        if (assignments.has(model.name))
            continue;
        const index = PROFILE_BACKED_PLACEHOLDERS.find((candidate) => !used.has(candidate));
        if (index === undefined)
            break;
        assignments.set(model.name, index);
        used.add(index);
    }
    for (const model of ordered) {
        if (assignments.has(model.name))
            continue;
        const start = hash(model.name) % exports.NATIVE_MODEL_CAPACITY;
        for (let offset = 0; offset < exports.NATIVE_MODEL_CAPACITY; offset++) {
            const index = (start + offset) % exports.NATIVE_MODEL_CAPACITY;
            if (used.has(index))
                continue;
            assignments.set(model.name, index);
            used.add(index);
            break;
        }
    }
    state.assignments = Object.fromEntries(assignments);
    state.reserved = [...reserved].sort((a, b) => a - b);
    if (JSON.stringify(state) !== before) {
        fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
        const temporary = `${filename}.${(0, node_crypto_1.randomUUID)()}.tmp`;
        try {
            fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
            fs.renameSync(temporary, filename);
        }
        finally {
            if (fs.existsSync(temporary))
                fs.unlinkSync(temporary);
        }
    }
    return models.map((model) => {
        const index = assignments.get(model.name);
        return {
            name: model.name,
            catalogId: (0, modelCatalog_1.catalogModelSlug)(model, models),
            ...(index === undefined ? {} : { placeholderId: `MODEL_PLACEHOLDER_M${index}`, placeholderValue: index + 1000 }),
        };
    });
}
//# sourceMappingURL=modelIdentity.js.map