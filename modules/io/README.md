# Antigravity v2 - I/O & Event Bus Subsystem (`modules/io`)

> The **I/O Module** is the central subsystem for inter-process communication (IPC), system stream interception (stdout/stderr), and asynchronous event routing in the Android/Linux environment for Google Antigravity v2.

---

## 1. Architectural Overview

The `modules/io` module is built on the **Publish/Subscribe Event Bus** architectural pattern, featuring stream interceptors and heterogeneous transport support (FIFO, UNIX Domain Sockets, Android Intents).

```
 +-------------------------------------------------------------------------------+
 |                               INPUT SOURCES                                   |
 |  [broadcast_receiver.sh]       [fifo_input.py]       [unix_socket_input.py]   |
 |   (Android am Intents)          (Named FIFO)           (AF_UNIX Stream)       |
 +-----------------------+---------------+-----------------------+---------------+
                         |               |                       |
                         +---------------+-----------------------+
                                         |
                                         v  JSON Event Envelopes
 +-------------------------------------------------------------------------------+
 |                             STREAM INTERCEPTORS                               |
 |   Core Server stdout/stderr ---> [stream_splitter.py]                         |
 |                                     |                                         |
 |             +-----------------------+-----------------------+                 |
 |             v                       v                       v                 |
 |     [filter_open_url.py]  [filter_task_events.py]  [filter_error_alerts.py]   |
 +-------------------------------------+-----------------------------------------+
                                       |
                                       v  envelope.create_event()
 +-------------------------------------------------------------------------------+
 |                               CORE EVENT BUS                                  |
 |                            [event_broker.py]                                  |
 |                                     |                                         |
 |                 +-------------------+-------------------+                     |
 |                 |                                       |                     |
 |                 v                                       v                     |
 |    In-Memory Handlers (Python)            [subscriber_router.py]              |
 |    (broker.register_handler)             (spec/default_routes.json)           |
 +---------------------------------------------------------+---------------------+
                                                           |
                                                           v  Process Dispatch
 +-------------------------------------------------------------------------------+
 |                               OUTPUT HANDLERS                                 |
 |  [notify_tray.sh]      [broadcast_emitter.sh]    [file_sink.py]  [socket_out] |
 |   Android Tray via         ACTION_OPEN_URL       events.jsonl    AF_UNIX IPC  |
 |   agy-notify / am          to Android Activity     Append Log     Forwarding  |
 +-------------------------------------------------------------------------------+
```

---

## 2. Event Specification (Event Envelope)

All events circulating through the bus strictly adhere to the `spec/event_schema.json` JSON schema (Draft-07).

### 2.1. Envelope Format
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AntigravityEventEnvelope",
  "type": "object",
  "required": ["event", "timestamp", "source", "data"],
  "properties": {
    "event": {
      "type": "string",
      "description": "Dot-separated event name, e.g. core.url.open, agent.task.started"
    },
    "timestamp": {
      "type": "integer",
      "description": "Epoch timestamp in milliseconds"
    },
    "source": {
      "type": "string",
      "description": "Event source, e.g. language_server:stdout, input:socket"
    },
    "data": {
      "type": "object",
      "description": "Arbitrary JSON payload for the event"
    }
  }
}
```

### 2.2. Serialization and Validation (`core_bus/envelope.py`)
- `create_event(event_type, source, data)`: Creates an event dictionary with current millisecond timestamp `int(time.time() * 1000)`.
- `serialize_event(envelope)`: Serializes an event dictionary to a UTF-8 JSON string.
- `deserialize_event(raw_text)`: Parses JSON and validates the presence of required fields.
- `validate_event(envelope)`: Verifies the presence of `event`, `timestamp`, `source`, `data` fields, ensures `event` is a non-empty string, and checks that `data` is a dictionary.

---

## 3. Bus Core (`core_bus/`)

### 3.1. Router (`subscriber_router.py`)
- Loads the routing table from a JSON configuration file (`spec/default_routes.json`).
- Supports wildcard pattern matching via `fnmatch.fnmatch` (e.g., `agent.task.*`, `core.*`, `*`).
- The `get_destinations(event_type)` method returns a sorted, deduplicated list of output handler scripts.

#### Default Routing Table (`spec/default_routes.json`)
| Event Pattern (`pattern`) | Handlers (`outputs`) | Purpose |
| :--- | :--- | :--- |
| `core.url.open` | `broadcast_emitter.sh`, `file_sink.py` | Opens authorization/OAuth URLs in the Android system browser |
| `agent.task.*` | `notify_tray.sh`, `file_sink.py` | Status bar notifications for agent task lifecycle events |
| `system.error` | `notify_tray.sh`, `file_sink.py` | Alerts for critical crashes and core panics |
| `external.*` | `file_sink.py` | External integration events |

### 3.2. Event Broker (`event_broker.py`)
- Central event dispatcher `EventBroker`.
- Supports two levels of subscribers:
  1. **In-Memory Handlers**: Python callbacks (`register_handler(pattern, callable)`), executed synchronously within the process.
  2. **External Script Handlers**: Invocations of external shell and Python scripts located in the `outputs/` directory.
- Dispatches external handlers via `subprocess.Popen`, passing the JSON envelope over `stdin` with a configurable execution timeout (default 5 seconds).
- **Zombie Process and FD Leak Protection**: On `subprocess.TimeoutExpired`, it guarantees calls to `proc.kill()`, `proc.wait()` to reap the process from the OS process table, and closes `stdin`/`stderr` stream file descriptors.
- Accommodates Android constraints: on `/storage/emulated/0` (`noexec` mount), `.sh` scripts are executed with an explicit interpreter (`/system/bin/sh` or `bash`).

---

## 4. Input Channels (`inputs/`)

1. **FIFO Pipe Listener (`inputs/fifo_input.py`)**
   - Listens on a named pipe (`mkfifo`), deserializes line-delimited JSON events, and publishes them to the `EventBroker`.
   - Invocation: `python3 fifo_input.py <path_to_fifo>`.
   - **FUSE Safety**: The `get_safe_pipe_path` function automatically reroutes paths from FUSE storage (`/storage/emulated/0`, `/sdcard`), where `mkfifo` raises `PermissionError`, to a safe internal runtime directory (`/data/user/0/.../runtime` or `$TMPDIR`).
   - **Non-blocking Write**: The `write_fifo_nonblocking(fifo_path, data)` function writes using the `O_NONBLOCK` flag, preventing hangs when no reader is connected.

2. **UNIX Domain Socket Listener (`inputs/unix_socket_input.py`)**
   - UNIX streaming socket server (`AF_UNIX`, `SOCK_STREAM`).
   - Accepts external IPC connections, buffers incoming streams delimited by `\n`, and forwards events to the broker.
   - Invocation: `python3 unix_socket_input.py <path_to_socket>`.

3. **Android Broadcast Receiver Bridge (`inputs/broadcast_receiver.sh`)**
   - Utility for translating Android Intents (e.g., from `am broadcast` or plugins) into bus JSON envelopes:
     `broadcast_receiver.sh <action> <payload_json> [destination_fifo]`
   - Formats events as `android.intent.<ACTION>` and writes them to the bus pipe or `stdout`.
   - Supports safe FUSE path resolution and non-blocking FIFO writes (via Python `O_NONBLOCK` or the `timeout` utility).

4. **Custom Source Template (`inputs/templates/template_input.sh`)**
   - Ready-to-use template for creating custom event generators (sensors, hooks, webhooks) with built-in FIFO blocking protection.

---

## 5. Stream Interceptors (`interceptors/`)

Interceptors are utilized during core server launch (`modules/runner/start_core.sh`), where core `stdout` and `stderr` are piped into `stream_splitter.py`.

### 5.1. Stream Splitter (`stream_splitter.py`)
- Reads lines from `sys.stdin`.
- Unconditionally duplicates them to `sys.stdout` (preserving the process passthrough log).
- **Asynchronous Event Queue (Queue Worker)**: Intercepted event publishing is offloaded to a `queue.Queue` serviced by an independent daemon background thread. This ensures event dispatching and external handler scripts never block the core server's `stdout`/`stderr` reads.
- Evaluates each line concurrently across the `FILTERS` chain.
- When a filter identifies an event marker, an envelope is generated via `envelope.create_event` and enqueued for publication.

### 5.2. Filter Modules (`interceptors/filters/`)
- `filter_open_url.py`: Intercepts prefixes `AGY_OPEN_URL=`, `ANTIGRAVITY_OPEN_URL:`, and OAuth URLs (`accounts.google.com`, `/auth/callback`), emitting `core.url.open`.
- `filter_task_events.py`: Tracks agent task phases (`[task:start]`, `[task:done]`, `tool_call:`), emitting `agent.task.started`, `agent.task.completed`, `agent.tool.executed`.
- `filter_error_alerts.py`: Monitors fatal errors (`panic:`, `fatal error:`, `sigsegv`, `sigill`), emitting `system.error`.

---

## 6. Output Handlers (`outputs/`)

1. **Android Tray Notifier (`outputs/notify_tray.sh`)**
   - Reads event JSON from `stdin`.
   - Extracts the event name and message body.
   - Posts an Android system notification via `agy-notify` or `am broadcast -a dev.continuum.antigravity.ACTION_NOTIFY`.

2. **Android Browser Intent Emitter (`outputs/broadcast_emitter.sh`)**
   - Receives `core.url.open` events.
   - Extracts the `url` field and broadcasts Android Intent `dev.continuum.antigravity.ACTION_OPEN_URL` for opening in an external browser or Custom Tabs.

3. **Persistent JSONL Logger (`outputs/file_sink.py`)**
   - Writes every incoming event to an append-only log file (defaults to `~/.gemini/events.jsonl` or the `AGY_EVENT_LOG` variable).

4. **UNIX Socket Emitter (`outputs/unix_socket_emitter.py`)**
   - Forwards events to external background processes or daemons via a UNIX socket client connection.

---

## 7. Unit Testing (`tests/`)

The test suite covers key bus components, verifying serialization accuracy and routing logic.

### 7.1. Running All Tests
```bash
bash modules/io/tests/run_all.sh
```

### 7.2. Test Suite Structure
| Test File | Verified Component | Verified Scenario |
| :--- | :--- | :--- |
| `test_envelope.py` | `envelope.py` | Type validation, envelope creation, roundtrip serialization/deserialization, invalid schema rejection |
| `test_event_broker.py` | `SubscriberRouter`, `EventBroker` | Wildcard route filtering (`*`, `core.*`), in-memory dispatching, external script timeouts with `proc.kill()`/`proc.wait()` and FD cleanup (`test_03_timeout_cleanup`) |
| `test_fifo_io.py` | `fifo_input.py`, `EventBroker` | Integration test: FIFO creation, background listener thread, event publishing and receiving, FUSE path rerouting, non-blocking write without reader |
| `test_stream_splitter.py` | `stream_splitter.py`, filters | `io.StringIO` test: original stream preservation + generation of `core.url.open` and `system.error`, asynchronous event queue via `queue.Queue` without core stream delays |
| `run_all.sh` | All components | Syntax validation for Python (`compileall`) and Bash (`bash -n`) + sequential execution of unit tests |

---

## 8. Reliability Audit and Technical Debt

During the audit, critical architectural and platform-specific issues were identified and resolved:

### 8.1. JSON Parsing in Shell Scripts [RESOLVED]
- **Issue**: `notify_tray.sh`, `broadcast_emitter.sh`, and `template_output.sh` used naive JSON parsing via `grep -o '"url":"[^"]*'`. Standard Python `json.dumps()` includes whitespace after colons (`"url": "..."`), causing field extraction to fail.
- **Solution**: Regular expressions were updated to support arbitrary whitespace `[[:space:]]*:[[:space:]]*` (`"url"[[:space:]]*:[[:space:]]*"[^"]*`). Compatibility verified across `/system/bin/sh` (Toybox) and Bash on Android.

### 8.2. Blocking Calls and Core Freeze Risk (Head-of-Line Blocking) [RESOLVED]
- **Issue**: `stream_splitter.py` is attached directly to the main core server's `stdout`. When a URL or error was detected, synchronous `broker.publish()` calls caused the Linux pipe buffer (64 KB) to fill up, freezing the core engine.
- **Solution**: Event publishing in `stream_splitter.py` was migrated to an asynchronous architecture using `queue.Queue` and a background daemon worker thread. `stdout`/`stderr` streams are read and flushed immediately.

### 8.3. File Descriptor Leaks and Zombie Processes on `subprocess.Popen` Timeout [RESOLVED]
- **Issue**: In `event_broker.py`, when a process timed out with `subprocess.TimeoutExpired`, child processes remained lingering in the background, and `stdin`/`stderr` file descriptors were never closed.
- **Solution**: Added a dedicated `except subprocess.TimeoutExpired` block that reliably calls `proc.kill()`, `proc.wait()` (reaping zombies from the OS process table), and closes open `stdin` and `stderr` file descriptors.

### 8.4. FIFO Write Blocking Without Active Reader [RESOLVED]
- **Issue**: In `broadcast_receiver.sh` and templates, direct writes `echo "$JSON" > "$FIFO"` blocked per POSIX specification until a reader attached.
- **Solution**: Added non-blocking writes via Python `os.O_NONBLOCK` or the `timeout 1s` utility in `broadcast_receiver.sh` and `template_input.sh`. Added `write_fifo_nonblocking` to `fifo_input.py`.

### 8.5. FIFO and UNIX Socket Incompatibility with Android FUSE [RESOLVED]
- **Issue**: Attempting to create a named pipe (`mkfifo`) on `/storage/emulated/0/...` resulted in `PermissionError: [Errno 13] Permission denied`.
- **Solution**: Implemented automatic recognition of FUSE prefixes (`/storage/`, `/sdcard/`, `/mnt/`) in `get_safe_pipe_path` (`fifo_input.py`) and `broadcast_receiver.sh`, transparently redirecting pipes to internal application storage (`/data/user/0/.../runtime` or `$TMPDIR`).

### 8.6. Code Duplication with the Java Layer
- **Status**: Architectural backlog. Link and prefix detection logic in `filter_open_url.py` duplicates `OpenUrlWatcher.java`. Unifying via `broadcast_receiver.sh` is recommended for future iterations.
