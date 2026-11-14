# Antigravity v2 - Environment, Diagnostics & System Gateway Subsystem (`modules/env`)

> The **`env` module** is a foundational subsystem for system environment management, dynamic Android/Linux path resolution, hardware and network diagnostics (preflight/port checker), structured telemetry logging, command execution auditing, and inter-process communication with the Android System Gateway for Google Antigravity v2.

---

## 1. Architectural Overview

The `modules/env` module eliminates runtime dependencies on fixed Android filesystem paths and provides a standardized execution environment:

```
 +-----------------------------------------------------------------------------------+
 |                             SPECIFICATION LAYER                                   |
 |          [spec/paths.json]                     [spec/env_vars.json]               |
 |       (Base Android path templates)       (Static vars, PATH, LD_LIBRARY_PATH)    |
 +--------------------------+---------------------------------+----------------------+
                            |                                 |
                            v                                 v
 +-----------------------------------------------------------------------------------+
 |                              CONTEXT & RESOLVER                                   |
 |         [path_resolver.py]                          [env_builder.py]              |
 |   Dynamic resolution of package_id,       Process assembly: HOME, PREFIX, PATH,   |
 |   app_root, runtime, prefix, cache        TMPDIR, GODEBUG, GIT_CONFIG_NOSYSTEM    |
 +--------------------------+---------------------------------+----------------------+
                            |                                 |
       +--------------------+----------------+----------------+----------------+
       |                                     |                                 |
       v                                     v                                 v
+--------------------------+  +--------------------------+  +--------------------------+
|  DIAGNOSTICS & PREFLIGHT |  |   LOGGING & CRASH DUMP   |  |     COMMAND RUNNER       |
|      [preflight.py]      |  |         [log.py]         |  |       [runner.py]        |
|  - Architecture (ARM64)  |  |  - ANSI Logger / JSONL   |  |  - Command execution     |
|  - Free space (>250MB)   |  |   [flight_recorder.py]   |  |  - Metrics: duration_ms  |
|  - Write permissions W_OK|  |  - Crash dump of memory  |  |  - Audit commands.jsonl  |
|    [port_checker.py]     |  |    and disk state        |  |  - Fallback & list       |
|  - TCP Loopback test     |  +--------------------------+  +--------------------------+
+--------------------------+                 |                                 |
                                             v                                 v
 +-----------------------------------------------------------------------------------+
 |                             IPC & SYSTEM GATEWAY                                  |
 |           [bridge/client.py]                           [bridge/commands.py]       |
 |    Auto-detection of gateway.port                High-level typed commands:       |
 |    Transport: POST http://127.0.0.1:port/gateway  notify, open, wakelock          |
 +-----------------------------------------------------------------------------------+
                                             |
                                             v
 +-----------------------------------------------------------------------------------+
 |                                CLI UTILITIES                                      |
 |          [cli/agy_system.py]                           [cli/agy_logs.py]          |
 |    Android notification management,              Core log inspector (core.log),   |
 |    Wakelock, Intent URL, Clipboard               crash dumps, and commands.jsonl  |
 +-----------------------------------------------------------------------------------+
```

---

## 2. Directory Structure

```
modules/env/
├── spec/
│   ├── paths.json               # JSON specification of the application filesystem structure
│   └── env_vars.json            # JSON specification of base environment variables
├── context/
│   ├── path_resolver.py         # Path resolver without hardcoding, package_id detector
│   └── env_builder.py           # Constructor for isolated process environments
├── diagnostics/
│   ├── preflight.py             # Preflight checker for architecture (ARM64), permissions, and disk space
│   └── port_checker.py          # Availability checker for local TCP ports
├── logging/
│   ├── log.py                   # Lightweight ANSI color + JSONL logger
│   └── flight_recorder.py       # Crash snapshot generator (JSON crash dump)
├── bridge/
│   ├── client.py                # IPC client for Android Gateway with automatic fallback
│   └── commands.py              # Typed system calls to the Android OS
├── cmd/
│   └── runner.py                # Telemetry command execution engine
├── cli/
│   ├── agy_system.py            # CLI controller for Android Gateway (notify, open, wakelock)
│   └── agy_logs.py              # CLI inspector for logs, command history, and crashes
└── tests/
    ├── run_all.sh               # Main syntax and unit test runner script
    ├── test_context.py          # Tests for path resolver and env builder
    ├── test_diagnostics.py      # Tests for preflight and port checker
    ├── test_logging.py          # Tests for logger and flight recorder
    ├── test_bridge.py           # Tests for gateway client and command typing
    └── test_cli.py              # Tests for agy_system and agy_logs CLI tools
```

---

## 3. Environment and Path Specification (`spec/`)

### 3.1. Filesystem Map (`spec/paths.json`)
Path templates utilize the `{package_name}` (or `{app_id}`) placeholder, resolved dynamically at runtime:
```json
{
  "app_root": "/data/user/0/{package_name}/files",
  "prefix": "/data/user/0/{package_name}/files/usr",
  "runtime": "/data/user/0/{package_name}/files/runtime",
  "cache": "/data/user/0/{package_name}/cache",
  "gemini_home": "/data/user/0/{package_name}/files/.gemini",
  "shared_storage": "/storage/emulated/0",
  "default_projects": "/storage/emulated/0/Documents"
}
```

### 3.2. Environment Variable Specification (`spec/env_vars.json`)
Defines base variables, `PATH` search order, and library directories:
```json
{
  "static": {
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "GODEBUG": "netdns=go",
    "ANTIGRAVITY_VSCODE_HOST": "1"
  },
  "relative_to_app": {
    "HOME": ".",
    "TMPDIR": "../cache"
  },
  "path_order": [
    "{runtime}/bin",
    "{prefix}/bin",
    "/system/bin"
  ],
  "ld_library_paths": [
    "{runtime}/lib",
    "{prefix}/lib"
  ]
}
```

---

## 4. Context and Dynamic Path Resolver (`context/`)

### 4.1. `path_resolver.py`
Eliminates hardcoded package names (`dev.continuum.antigravity` vs `dev.continuum.antigravity.dev` vs custom builds):
- `get_application_id() -> str`: Determines the package identifier by order of precedence:
  1. `AGY_APPLICATION_ID` environment variable
  2. `APPLICATION_ID` environment variable
  3. `DEV_MODE == "1"` flag (returns `dev.continuum.antigravity.dev`)
  4. Default fallback: `dev.continuum.antigravity`
- `load_paths(custom_spec=None, app_id=None) -> Dict[str, str]`: Loads and interpolates paths from `paths.json`, ensuring absolute paths via `os.path.abspath(os.path.expanduser(...))`.
- `resolve_subpath(key: str, rel_path: str, custom_spec=None, app_id=None) -> str`: Safely joins subpaths. To prevent discarding the root path when a leading slash is passed (`/bin/tool`), `rel_path.lstrip("/")` is applied.

### 4.2. `env_builder.py`
- `build_process_env(custom_spec_dir=None, extra_env=None, app_id=None) -> Dict[str, str]`:
  Constructs a clean, deterministic environment dictionary for spawned processes:
  - `HOME`: Set to `paths["app_root"]`
  - `PREFIX`: Linux userspace prefix `paths["prefix"]` (`/data/user/0/{package}/files/usr`)
  - `TMPDIR`: Cache directory `paths["cache"]`
  - `GIT_CONFIG_NOSYSTEM`: Set to `"1"` (prevents missing Termux system config errors)
  - `AGY_APPLICATION_ID`: Active package identifier
  - `PATH`: Assembled from `{runtime}/bin:{prefix}/bin:/system/bin`
  - `LD_LIBRARY_PATH`: Directories `{runtime}/lib` and `{prefix}/lib` (if directories exist)
  - `extra_env`: Additional custom user environment variables

---

## 5. System Diagnostics (`diagnostics/`)

### 5.1. Preflight Checker (`diagnostics/preflight.py`)
Verifies Android host readiness prior to deployment or core startup:
```python
def run_preflight(app_root: Optional[str] = None, min_mb_free: int = 250) -> Dict[str, Any]
```
- **CPU Architecture**: Checks `platform.machine()`. Only `aarch64` / `arm64` are permitted.
- **Available Disk Space**: Checks free space on the `app_root` partition via `shutil.disk_usage()`. Default threshold is at least 250 MB.
- **Write Permissions**: Verifies `os.access(app_root, os.W_OK)`.
- **Dynamic Fallback**: If `app_root` is not specified, dynamically resolves it via `path_resolver`, falling back to `$HOME`.

### 5.2. Port Availability Validator (`diagnostics/port_checker.py`)
```python
def check_port_available(port: int, host: str = "127.0.0.1") -> Dict[str, Any]
```
- Tests TCP socket binding (`socket.bind`) to the loopback interface with a 0.5s timeout.
- Returns `{"port": port, "available": True/False, "error": None/str}`.

---

## 6. Logging and Crash Post-Mortem (`logging/`)

### 6.1. Structured Logger (`logging/log.py`)
```python
def log(level: str, tag: str, message: str, meta: Dict[str, Any] = None, jsonl_file: str = None) -> None
```
- **ANSI Colors**: `DEBUG` (gray), `INFO` (blue), `OK` (green), `WARN` (yellow), `ERROR` (red).
- **`NO_COLOR` Support**: Automatically strips escape sequences when `NO_COLOR` is set or `TERM=dumb`.
- **Stream Separation**: Logs with `ERROR` level are emitted to `sys.stderr`, while other levels go to `sys.stdout`.
- **JSONL Streaming**: When `jsonl_file` is specified, writes atomic JSON Lines entries with millisecond timestamps (`ts`). Operations are safeguarded within a `try-except` block.

### 6.2. Crash Flight Recorder (`logging/flight_recorder.py`)
```python
def record_crash_snapshot(error_msg: str, dump_path: str, extra_context: Dict[str, Any] = None) -> str
```
- Generates a comprehensive post-mortem snapshot of an incident:
  - Exact timestamp (epoch ms and ISO 8601 UTC)
  - Error message and contextual details (`extra_context`)
  - Platform data, architecture, Python version, PID
  - Target directory filesystem state (`shutil.disk_usage`)
- Saves formatted JSON to `dump_path`.

---

## 7. System Gateway and IPC Bridge (`bridge/`)

Enables inter-process communication between Python scripts, background tasks, and Android system services via `CoreServerService` (Android System Gateway).

### 7.1. IPC Client (`bridge/client.py`)
- `resolve_gateway_url() -> str`:
  1. Checks the `AGY_GATEWAY_URL` environment variable.
  2. Searches for the dynamic port file `gateway.port` in `$HOME/logs/gateway.port`, `app_root/logs/gateway.port`, and standard `dev.continuum.antigravity.dev` / `dev.continuum.antigravity` directories.
  3. If the file is not found, selects a default port: `45161` for `DEV_MODE=1` / `dev.continuum.antigravity.dev`, or `45160` for production.
- `send_command(command: str, payload: dict = None, gateway_url: str = None) -> dict`:
  - Dispatches an HTTP POST request with a JSON envelope `{command, payload}` to the `/gateway` endpoint.
  - Automatic failover: retries connection on the alternate port (`45160` <-> `45161`) if the primary port is unreachable.
  - Returns `{ok: False, fallback: True, error: ...}` when unable to communicate with the gateway, avoiding unhandled exceptions.

### 7.2. Typed Command Facade (`bridge/commands.py`)
- `notify(title, message, progress=None, tag="agy_status", channel="agy_tasks", ongoing=False) -> dict`: Posts an Android status bar notification with progress bar (0-100) and ongoing pin support.
- `cancel_notify(tag="agy_status", notification_id=1001) -> dict`: Dismisses an active notification.
- `open_url(url: str) -> dict`: Opens a web link or deep link via Android Intent (`ACTION_VIEW`).
- `wakelock(acquire=True, tag="agy_task") -> dict`: Acquires or releases a CPU `PARTIAL_WAKE_LOCK`.
- `clipboard_set(text: str) -> dict`: Copies text to the Android system clipboard.
- `clipboard_get() -> dict`: Reads text from the Android system clipboard.
- `system_info() -> dict`: Queries battery status, network state, available RAM, and free disk space.

---

## 8. Command Execution and Auditing Engine (`cmd/runner.py`)

A utility and library for transparent shell command execution with detailed profiling and auditing:

```bash
# Execute command with telemetry:
python3 modules/env/cmd/runner.py run "echo 'Hello Antigravity'"

# Direct invocation:
python3 modules/env/cmd/runner.py pkg list

# View recently executed commands:
python3 modules/env/cmd/runner.py list 20
```

- Calculates precise execution duration in milliseconds (`duration_ms`).
- Appends every command to an append-only audit log `commands.jsonl` in the application log directory (`$HOME/logs/commands.jsonl`).
- Renders a formatted execution tree with return code, duration, and output preview lines.

---

## 9. CLI Interfaces (`cli/`)

### 9.1. System Controller (`cli/agy_system.py`)

Unified terminal interface for managing Android features:

```bash
# 1. System notifications:
python3 modules/env/cli/agy_system.py notify -t "Build Finished" -m "APK compiled successfully" --tag "build"
python3 modules/env/cli/agy_system.py notify -t "Downloading" --progress 75 --ongoing
python3 modules/env/cli/agy_system.py notify cancel --tag "build"

# 2. Open URL in default system browser / Custom Tabs:
python3 modules/env/cli/agy_system.py open "https://github.com"

# 3. Background execution management (Wakelock):
python3 modules/env/cli/agy_system.py wakelock on --tag "long_job"
python3 modules/env/cli/agy_system.py wakelock off --tag "long_job"

# 4. Android host diagnostics:
python3 modules/env/cli/agy_system.py info
python3 modules/env/cli/agy_system.py --json info

# 5. Clipboard:
echo "secret token" | python3 modules/env/cli/agy_system.py clipboard set
python3 modules/env/cli/agy_system.py clipboard get
```

### 9.2. Telemetry and Log Inspector (`cli/agy_logs.py`)

Inspection tool for analyzing Antigravity core runtime status:

```bash
# 1. View recent general log lines:
python3 modules/env/cli/agy_logs.py -n 50

# 2. Filter by channel and severity level:
python3 modules/env/cli/agy_logs.py --channel core --level ERROR

# 3. Audit executed commands:
python3 modules/env/cli/agy_logs.py --commands -n 25

# 4. Detailed inspection of a specific command (STDOUT, STDERR, timing):
python3 modules/env/cli/agy_logs.py --cmd-id "cmd_1792097231_1ec8"

# 5. Inspect the latest crash report:
python3 modules/env/cli/agy_logs.py --crash
python3 modules/env/cli/agy_logs.py --crash --json
```

---

## 10. Unit Testing (`tests/`)

The test suite provides 100% component coverage for the `env` subsystem.

### Running Tests
```bash
bash modules/env/tests/run_all.sh
```

### Test Suite Structure
| Test File | Component | Verified Scenario |
| :--- | :--- | :--- |
| `test_context.py` | `path_resolver`, `env_builder` | 9 tests: path resolution, subpaths with leading slashes, environment variables `HOME`, `PREFIX`, `TMPDIR`, `GIT_CONFIG_NOSYSTEM`, dynamic `AGY_APPLICATION_ID`, `DEV_MODE`, and `app_id` overrides. |
| `test_diagnostics.py` | `preflight`, `port_checker` | 3 tests: current filesystem validation, default preflight without arguments, free TCP loopback port validation. |
| `test_logging.py` | `log`, `flight_recorder` | 2 tests: structured JSONL stream writing, crash snapshot generation with platform and disk metadata collection. |
| `test_bridge.py` | `client`, `commands` | 5 tests: automatic gateway fallback in offline mode, URL formatting, wakelock, `typing.get_type_hints()` introspection, and validation of all command methods. |
| `test_cli.py` | `agy_system`, `agy_logs` | 6 tests: CLI help invocation, JSON system info parsing, crash report verification, clipboard JSON reading, and command auditing via `--commands`. |

---

## 11. Reliability Audit, Identified Bugs, and Fixes

During an in-depth source code audit of the `modules/env` subsystem, critical architectural defects, Android path errors, and typing issues were identified and resolved:

### 11.1. Critical Path Hardcoding in `preflight.py`
- **Issue**: In `run_preflight`, the default parameter value was hardcoded: `app_root: str = "/data/user/0/dev.continuum.antigravity/files"`.
- **Impact**: In debug builds (`dev.continuum.antigravity.dev`) or custom packages, invoking `run_preflight()` without arguments checked a non-existent production package directory (`dev.continuum.antigravity`). Consequently, `os.path.exists()` returned `False`, `free_mb = 0`, and preflight unconditionally reported `ok: False`, blocking core startup.
- **Fix**: Changed the parameter to `app_root: Optional[str] = None`. Added cascading dynamic resolution: `path_resolver.load_paths()["app_root"]` -> `$HOME` -> fallback.

### 11.2. Typing Error `NameError: Optional` in `bridge/commands.py`
- **Issue**: Function signatures used type annotations `Optional[int]` and `Dict[str, Any]`, but the import from `typing` was missing.
- **Impact**: Type introspection (e.g., via `typing.get_type_hints(commands.notify)` or Pydantic/FastAPI validation) raised `NameError: name 'Optional' is not defined` on Python 3.10+.
- **Fix**: Added explicit imports `from typing import Dict, Any, Optional`, and implemented the missing methods `clipboard_get()`, `cancel_notify()`, and `system_info()`.

### 11.3. Suppressed Logging and Hardcoded Paths in `cmd/runner.py`
- **Issue**: The `LOG_DIR` path was hardcoded to `/data/user/0/dev.continuum.antigravity/files/logs`.
- **Impact**: In a `dev.continuum.antigravity.dev` environment, directory creation or writing to `commands.jsonl` failed with `PermissionDenied`, which was silently swallowed by `except Exception: pass`. All commands executed via `runner.py` lost audit history.
- **Fix**: Implemented `_resolve_log_dir()`, giving priority to `$HOME/logs` and `path_resolver`.

### 11.4. Unreachable Logs and Crash Dumps in `cli/agy_logs.py`
- **Issue**: File paths for `commands.jsonl`, `logs/core.log`, and `logs/crashes` were hardcoded to `dev.continuum.antigravity`. Additionally, `read_file_fallback` checked `~/.gemini/logs/core.log`, whereas the real file is created in `$HOME/logs/core.log`.
- **Impact**: When the Android Gateway was offline, `agy_logs.py` could not find any log files and rendered empty output.
- **Fix**: Introduced `_find_commands_log()`, unified paths with the dynamic resolver, and added `$HOME/logs/core.log` to the candidate list for `core.log`.

### 11.5. Duplicated Gateway Port Discovery Logic
- **Issue**: `resolve_gateway_url()` in `bridge/client.py` and `get_gateway_base()` in `cli/agy_logs.py` contained duplicate code, and both functions checked only static paths for `gateway.port`.
- **Fix**: `agy_logs.py` now imports the centralized method from `bridge.client`, and the resolver itself checks `$HOME/logs/gateway.port` as well as the environment flag `AGY_APPLICATION_ID == "dev.continuum.antigravity.dev"`.

### 11.6. Missing `$PREFIX` and `$GIT_CONFIG_NOSYSTEM` in `env_builder.py`
- **Issue**: `PREFIX` (`/data/user/0/{package}/files/usr`) is a key environment variable in Android userland (Termux / AGY). Despite `"prefix"` existing in `paths.json`, `env_builder.py` failed to export `PREFIX`. The `GIT_CONFIG_NOSYSTEM=1` flag was also omitted.
- **Fix**: Added explicit assignment `env["PREFIX"] = paths["prefix"]` and `env["GIT_CONFIG_NOSYSTEM"] = "1"`.

### 11.7. Path Discard Bug in `path_resolver.resolve_subpath`
- **Issue**: In the Python standard library, calling `os.path.join("/a/b", "/c")` returns `"/c"`. Passing a relative path with a leading slash (e.g. `resolve_subpath("runtime", "/bin/sh")`) caused the base path to be discarded.
- **Fix**: Added normalization via `rel_path.lstrip("/")`.

### 11.8. Ignored `--json` Flag and Silent Failures in `cli/agy_system.py`
- **Issue**: The `clipboard` subcommand ignored the `--json` argument and did not inform the user when gateway communication failed.
- **Fix**: Implemented raw JSON output when `--json` is passed, and error reporting to `stderr` with non-zero exit codes.
