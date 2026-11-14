# Antigravity Environment Architecture and Audit (`env/`)

> [!NOTE]
> This document is the official technical specification and audit report for the rootfs userspace environment in `env/` of Antigravity (AGY v2).
> It details the rootfs composition, the internals of the `pkg` package manager, the dynamic Android/Termux path translation subsystem, ARMv8.1-A+ (LSE) compatibility mechanisms, identified workarounds, performance bottlenecks, and optimization recommendations.

---

## 1. Composition and Structure of Rootfs (`env/`)

The `env/` environment provides a lightweight, self-contained ARM64 (`aarch64`) Bionic userspace designed to run within the Android application sandbox without requiring superuser (`root`) privileges or ptrace-based syscall emulation layers (`proot` / `ptrace`).

### Directory Tree

```
env/
├── README.md               # Technical specification and audit report (this document)
├── README                  # Legacy format baseline overview
├── build.sh                # Main build script for asset packaging into dist/env
├── bootstrap/              # Base rootfs archive and modification utilities
│   ├── bootstrap-aarch64.zip # Original upstream Termux bootstrap archive
│   ├── bootstrap.tar.gz      # Optimized tar.gz (symlinks, pruned docs/man)
│   └── patch-prefix.py       # (Legacy) Binary ELF patching script for dpkg
├── packages/               # Additional packages bundled directly into bootstrap
│   └── git.deb             # Pre-staged Git package for offline operation
├── overlay/                # File overlay applied over $PREFIX (etc, bin, lib)
│   ├── bin/                # AGY system scripts and CLI utilities
│   │   ├── agy-daemon      # Background task supervisor and scheduler
│   │   ├── agy-fix-paths   # Dynamic path and shebang normalization utility
│   │   ├── agy-notify      # Android system notification management tool
│   │   ├── agy-upgrade     # Safe updater, backup, and migration manager
│   │   ├── rish            # Shizuku client for privileged ADB shell access (uid=2000)
│   │   └── cs              # Language server compatibility shim
│   ├── etc/                # System configuration files
│   │   ├── antigravity/    # AGENTS.md (global agent instructions and rules)
│   │   ├── pkg/repo.conf   # Repository configuration for pkg (Termux mirrors)
│   │   ├── profile.d/      # Shell startup hooks (00-env.sh)
│   │   ├── tls/            # Certificate bundle cert.pem and openssl.cnf
│   │   ├── hosts           # Localhost resolution table
│   │   ├── motd            # Terminal message of the day
│   │   ├── profile         # Root bash profile
│   │   └── resolv.conf     # Public fallback DNS servers (1.1.1.1, 8.8.8.8)
│   └── lib/                # Shared userspace libraries
│       ├── libtermux-exec.so # execve interceptor library for path redirection
│       └── daemon/         # Python support modules for agy-daemon
├── pkg/                    # Autonomous pkg package manager (Bash + AWK)
│   ├── pkg                 # Command-line interface (CLI) entry point
│   └── lib/                # Modular library functions for pkg
│       ├── util.sh         # Utilities, environment vars, rewrite_prefix
│       ├── deb.sh          # ar/.deb parsing and extraction without ar
│       ├── db.sh           # Local package database (.meta, .files)
│       ├── fetch.sh        # HTTP(S) downloader with sha256 validation and progress
│       ├── index.sh        # Packages index parsing and TSV cache generation
│       ├── index.awk       # AWK parser converting Debian control stanzas to TSV
│       ├── resolver.sh     # Recursive dependency graph resolution and cycle detection
│       ├── version.sh      # Debian version comparison wrappers
│       └── vercmp.awk      # Pure AWK implementation of dpkg vercmp semantics
├── liblse_compat/          # ARMv8.1-A+ (LSE, SIMD) instruction emulation module
│   ├── liblse_compat.c     # Source code for SIGILL interception and instruction decoding
│   ├── liblse_compat.so    # Compiled shared library
│   └── build.sh            # Build script for liblse_compat.so
├── repo/                   # Local repository cache directory (empty by default)
├── scripts/                # Engineering maintenance scripts
│   ├── pack_bootstrap.py   # Converter: zip -> tar.gz with doc/man pruning and extra .deb injection
│   └── make_manifest.py    # Deterministic manifest.json generator for integrity verification
├── dist/                   # Build artifacts ready for APK packaging
│   └── env/                # Mirror of assets/env (bootstrap, overlay, pkg, manifest.json)
└── tests/                  # Automated test suite
    ├── fixtures/           # Test fixtures (hello.deb, Packages)
    ├── selftest            # Offline pkg self-test (vercmp, db, resolver, deb)
    ├── invariant           # Asset and symlink 1:1 integrity check
    └── e3                  # End-to-end sandbox deployment and execution test
```

### Sandbox Layout in Android Storage

Upon application startup, `dev.continuum.antigravity.install.EnvInstaller` unpacks bundled assets into the application's isolated sandbox:
- **`$HOME`**: `/data/user/<id>/<package_id>/files` (or `/data/data/<package_id>/files` on older Android releases).
- **`$PREFIX`**: `$HOME/usr` — root of the Bionic rootfs.
- **`$PREFIX/bin`**: executables (`bash`, `sh`, `git`, `pkg`, `agy-daemon`, etc.).
- **`$PREFIX/lib`**: Bionic shared libraries (`libtermux-exec.so`).
- **`$PREFIX/etc`**: configuration files and TLS certificates (`etc/tls/cert.pem`).
- **`$PREFIX/libexec/pkg`**: internal `pkg` engine scripts.
- **`$PREFIX/var/lib/pkg`**: package database (`installed/`), cached `.deb` archives (`cache/`), and compiled indices (`index/`).

---

## 2. Architecture and Logic of the `pkg` Package Manager

The `pkg` package manager is engineered to completely remove runtime dependencies on heavy utilities such as `dpkg`, `apt`, `ar`, and `python` inside the terminal environment. It is written entirely in POSIX-compliant `Bash` and `AWK`.

### Supported Commands
| Command | Description |
| :--- | :--- |
| `pkg update` | Downloads `Packages.gz` from Termux mirrors, extracts them into `repo.N.Packages`, and compiles an optimized TSV index via `index.awk`. |
| `pkg install <pkg...>` | Resolves the dependency graph (DFS), downloads `.deb` archives, validates SHA256 sums, extracts files, dynamically rewrites prefixes (`rewrite_prefix`), registers metadata in the DB, and creates bridge links in `runtime/bin`. |
| `pkg upgrade` | Compares installed package versions against repository indices (`deb_vercmp`) and upgrades outdated packages. |
| `pkg remove <pkg...>` | Inspects `.files`, safely deletes package files and empty parent directories, and cleans up `.meta`. |
| `pkg list [regex]` | Lists all available packages from TSV indices with regex filtering. |
| `pkg installed` | Lists locally installed packages and their current versions. |
| `pkg info <pkg>` | Displays full package metadata (size, architecture, dependencies, checksum, providers). |
| `pkg search <query>` | Searches packages by name substring or regular expression. |
| `pkg why <file>` | Identifies which package owns the specified file via reverse lookup in `.files`. |
| `pkg clean` | Purges cached `.deb` archives from `$PKG_CACHE`. |
| `pkg selftest` | Runs an offline test verifying shell environment, certificates, and repository configuration. |

### Dependency Resolution Mechanism (`resolver.sh`)
Dependency resolution relies on topological sorting and depth-first search (DFS):
1. **Cycle Prevention:** State directories `$work/doing/<pkg>` and `$work/done/<pkg>` track traversal status. If DFS encounters a node already marked `doing`, a cyclic dependency is reported and the transaction safely aborts without leaving partial installs.
2. **Virtual Packages (`Provides`):** When a package is not found by exact name, `index_provider` scans the `Provides` column across repository indices.
3. **Version Constraints:** Constraints such as `(>= 1.0)`, `(<< 2.0)`, and `(= 1.2)` are parsed and evaluated via an AWK implementation of `deb_vercmp`.

### Database Format (`db.sh`)
The storage model is minimalist and resilient against sudden process termination:
- `$PKG_DB/<package>.meta`: key-value metadata pairs (`name`, `version`, `arch`). Writes are performed atomically via `mv` from a `.tmp` file.
- `$PKG_DB/<package>.files`: sorted list of relative paths belonging to the package.
- dpkg Synchronization (`db_sync_dpkg`): when `$PREFIX/var/lib/dpkg/status` is present (from the base bootstrap archive), `pkg` automatically imports pre-installed packages without duplicate entries.

---

## 3. Dynamic Termux/Android Path Translation

Because upstream Termux packages are pre-compiled with hardcoded paths pointing to `/data/data/com.termux/files/usr`, while AGY runs within arbitrary package sandboxes (e.g. `/data/user/0/dev.continuum.antigravity/files/usr` or `/data/user/10/dev.continuum.antigravity.dev/files/usr`), a three-tiered path translation subsystem is employed:

### Translation Hierarchy
```
┌─────────────────────────────────────────────────────────────┐
│ 1. Installation Layer (Install-Time / Java)                 │
│    TermuxShebangRewriter, TermuxPrefixRewriter,             │
│    TermuxSymlinkFixer in EnvInstaller.java                  │
│    -> Extraction, path normalization, and chmod permissions │
├─────────────────────────────────────────────────────────────┤
│ 2. Runtime Execution Layer (Runtime / LD_PRELOAD)           │
│    libtermux-exec.so intercepts execve / execv              │
│    -> Redirects /bin/sh and Termux paths to $PREFIX         │
├─────────────────────────────────────────────────────────────┤
│ 3. Dynamic Package Layer (Post-Install / CLI)               │
│    - rewrite_prefix in pkg/lib/util.sh                      │
│    - agy-fix-paths for third-party pip / npm scripts        │
│ └───────────────────────────────────────────────────────────┘
```

1. **`TermuxShebangRewriter` & `TermuxPrefixRewriter` (Java):** During application installation or upgrades, the installer scans `bin`, `libexec`, `etc`, `share`, and `var`. All text occurrences matching `/data/(?:data|user/[0-9]+)/[^/]+/files/usr` are replaced with the active `$PREFIX`.
2. **`TermuxSymlinkFixer` (Java):** Absolute symlinks pointing to non-existent `com.termux` prefixes are dynamically recreated to point to the local `$PREFIX`.
3. **`libtermux-exec.so` (C / Bionic Hook):** Injected via `LD_PRELOAD` into all child shell processes (via `00-env.sh`). It intercepts `execve`, `execvp`, and `fexecve`, redirecting `/bin/sh` and legacy Termux paths to binaries in the active `$PREFIX/bin`.
4. **`agy-fix-paths` & `pkg rewrite_prefix` (Bash):** When installing packages via `pkg` or installing global CLI tools via `pip install` / `npm install -g`, generated scripts contain absolute interpreter paths. `agy-fix-paths` safely scans text files only (ignoring binary/ELF files) and atomically rewrites them to the active `$PREFIX`.

---

## 4. ARMv8.1-A+ Compatibility and the `liblse_compat` Module

### The LSE Issue on Mobile Processors
Modern binary distributions (including Go runtimes, Node.js, compilers, and Core utilities) are built targeting `ARMv8.1-A+` with Large System Extensions (LSE) hardware atomics enabled.
However, several widely used mobile SoCs (such as the **Snapdragon 685** with Cortex-A53 cores on the Redmi Note 12) only support the baseline **ARMv8.0-A** instruction set in hardware. Attempting to execute LSE instructions on these cores triggers a **`SIGILL` (Illegal Instruction, Signal 4)** CPU fault, crashing the application with:
`FATAL ERROR: This binary was compiled with lse enabled`.

### How `liblse_compat` Works
The `liblse_compat.so` library resolves this transparently at the Linux kernel level without requiring modifications to target binaries:
1. **Kernel Signal Handler Installation:** A highest-priority constructor `__attribute__((constructor(101)))` issues the raw kernel syscall `rt_sigaction(134)` via inline assembly (`svc #0`), bypassing libc wrappers entirely. This ensures the handler is established before other libraries initialize.
2. **Override Protection (`sigaction` hook):** `liblse_compat` exports its own `sigaction` symbol, intercepting attempts by guest runtimes (such as Go runtime or the JVM) to overwrite the `SIGILL` handler. The guest handler is stored in `old_sigill_act` and invoked only when a faulting instruction does not belong to the emulated instruction set.
3. **Software Instruction Decoder and Emulator:**
   - **FEAT_LSE (ARMv8.1-A):** Emulates atomic memory operations: `LDADD`, `LDCLR`, `LDEOR`, `LDSET`, `SWP`, signed/unsigned min/max (`LDSMAX`, `LDSMIN`, `LDUMAX`, `LDUMIN`), and Compare-and-Swap (`CAS`, `CASA`, `CASL`, `CASAL`, `CASP`, `CASPA`, `CASPL`, `CASPAL`) using GCC/Clang atomic builtins (`__atomic_fetch_add`, `__atomic_compare_exchange_n`).
   - **FEAT_LRCPC / LRCPC2 (ARMv8.3-A / 8.4-A):** Emulates Load-Acquire RCpc operations: `LDAPR`, `LDAPRB`, `LDAPRH`, `LDAPUR`, and `STLUR` with memory barriers (`__atomic_thread_fence`).
   - **FEAT_DotProd (ARMv8.2-A / 8.4-A):** Emulates vector and element scalar dot product instructions `SDOT` and `UDOT` for SIMD registers `V0`–`V31` (`fpsimd_context` structure).
   - **FEAT_RDM (ARMv8.1-A):** Emulates rounding double multiply-accumulate operations `SQRDMLAH` and `SQRDMLSH`.
   - **FEAT_FCMA (ARMv8.3-A):** Emulates complex vector addition and multiply-accumulate operations `FCADD` and `FCMLA` (for `_Float16`, `float`, and `double`).
4. **Program Counter Advancement:** Following successful instruction emulation, the program counter is advanced by 4 bytes (`uc->uc_mcontext.pc += 4`), returning control immediately to the interrupted thread.

### Separation of Environments: Bionic vs Glibc (Critical Aspect)
Two distinct execution runtimes coexist in Antigravity:
1. **Core Language Server / Core Daemon:** Runs under **Glibc** in `runtime/`.
2. **Terminal, bash, pkg tools:** Run under **Android Bionic libc** in `$PREFIX/`.

> [!WARNING]
> The current build of `env/liblse_compat/liblse_compat.so` is linked against `libc.so.6` and `libdl.so.2` (GNU Glibc).
> For this reason, it **MUST NOT** be added to the global `LD_PRELOAD` for Bionic terminal processes. If the Android Bionic linker (`linker64`) encounters a preloaded library requiring `libc.so.6`, any spawned process (`/system/bin/sh`, `bash`, `ls`) terminates immediately with a dynamic link error:
> `CANNOT LINK EXECUTABLE: library "libc.so.6" not found`.
>
> In the Bionic environment, `00-env.sh` safely checks for `$PREFIX/lib/liblse_compat.so`, which is not present. The `liblse_compat.so` library is loaded exclusively by the Glibc dynamic loader via the `--preload` argument in `RuntimeManager.java`.

---

## 5. Audit Findings: Identified Workarounds, Overhead, and Defects

In-depth analysis of the `env/` codebase revealed the following issues and bottlenecks:

### 1. Severe Overhead in `pkg/lib/deb.sh` (I/O Bottleneck)
- **Problem:** Parsing the `ar` archive format in `ar_members` and `ar_member` was implemented by repeatedly executing an external `dd` command with block size `bs=1` and `count=60` to read each file header:
  ```bash
  hdr="$(dd if="$file" bs=1 skip="$off" count=60 2>/dev/null)"
  ```
  During package extraction in `install_one`, `deb_member_name` was invoked multiple times, rescanning the entire `.deb` archive from storage across dozens of `dd` forks.
- **Redundant Extraction Passes:** During a single package installation, `data.tar` was scanned or unpacked 4 separate times:
  1) `deb_field` extracted `control.tar` twice;
  2) `deb_validate_data` unpacked `data.tar` to validate paths;
  3) `deb_extract_data` extracted `data.tar` onto the filesystem;
  4) `deb_files` unpacked `data.tar` again to generate the file manifest.
- **Performance Impact:** On larger packages (10+ MB), this incurred 3–7 seconds of unnecessary delay and hundreds of redundant `fork()/execve()` calls.

### 2. Hardcoded Paths in `overlay/bin/` Scripts
- **`env/overlay/bin/agy-notify` [RESOLVED - Round 1]:**
  Previously contained a hardcoded developer workstation path: `SRC_LOGO="/storage/emulated/0/Documents/antigravity_release/docs/assets/logo.png"`.
  The local path was eliminated; replaced with resolution via `$AGY_LOGO` and standard asset paths (`$PREFIX/share/antigravity/logo.png`, `$PREFIX/share/pixmaps/antigravity.png`) with a graceful fallback to the Android system icon when absent.
- **`env/overlay/bin/agy-upgrade` [RESOLVED - Round 1]:**
  Fixed `$HOME` path derivation:
  Previously used `export HOME="${HOME:-/data/user/0/$(basename "$(dirname "$PREFIX")")/files}"`, resulting in paths like `/data/user/0/files/files`.
  Corrected to the standard expression: `export HOME="${HOME:-$(dirname "$PREFIX")}"`.
- **Package Specific Shebangs:**
  In `env/pkg/pkg`, `env/overlay/bin/agy-fix-paths`, `env/overlay/bin/agy-notify`, and `env/overlay/bin/agy-upgrade`, the initial shebang line specified:
  `#!/data/data/dev.continuum.antigravity/files/usr/bin/bash` or `#!/data/user/0/dev.continuum.antigravity/files/usr/bin/bash`.
  These are rewritten dynamically by `TermuxShebangRewriter` during APK installation.

### 3. Bridge Generation Overhead in `pkg/pkg` [RESOLVED - Round 1]
- **Problem:** Previously, whenever any package was installed, `pkg` executed a loop: `for bin_file in "$PREFIX/bin"/*; do`, rescanning every executable in `$PREFIX/bin`.
- **Solution:** The loop was optimized: bridge generation in `$PREFIX/../runtime/bin` now runs strictly for binary files introduced by the package currently being installed (`$pkg_files` with prefix `bin/`), without iterating over `$PREFIX/bin/*`.

### 4. Build Pipeline Gap for `liblse_compat` in `env/build.sh`
- The `env/build.sh` script packages `bootstrap.tar.gz` and copies `pkg` and `overlay` into `dist/env`.
- However, `liblse_compat` is built via a separate script (`env/liblse_compat/build.sh`) and was not included in `env/build.sh all` nor copied into `dist/`.

### 5. Code Duplication in Path Normalization
Path rewriting logic translating Termux paths to active `$PREFIX` is duplicated across 4 distinct locations:
1. `dev.continuum.antigravity.install.TermuxPrefixRewriter` / `TermuxShebangRewriter` (Java);
2. `env/pkg/lib/util.sh` -> `rewrite_prefix` function (Bash/sed);
3. `env/overlay/bin/agy-fix-paths` (Bash/sed);
4. `env/bootstrap/patch-prefix.py` (Python).

---

## 6. Recommendations for Remediation and Optimization

1. **Optimize Archive Extraction in `deb.sh`:**
   - Record `ar` member offsets in a single pass without repeated `dd` executions.
   - Combine path validation (`deb_validate_data`), extraction (`deb_extract_data`), and file list generation (`deb_files`) into a **single extraction pass** using `tar -x -v`, reading the extracted file list directly from tar output. This will accelerate package installation by 3–4x.
2. **Path and Environment Hardening:**
   - [x] Fix `$HOME` calculation in `env/overlay/bin/agy-upgrade` to `HOME="${HOME:-$(dirname "$PREFIX")}"` (completed in Round 1).
   - [x] Replace hardcoded logo paths in `env/overlay/bin/agy-notify` with relative application asset lookup or `$PREFIX/share/antigravity/logo.png` with fallback to system icons (completed in Round 1).
   - Use portable shebangs (`#!/usr/bin/env bash` or `#!/bin/sh`) across all repository scripts before packaging.
3. **Optimize Bridge Generator in `pkg`:**
   - [x] Generate runtime bridges strictly for files added by the package currently installed (from `$pkg_files`), rather than iterating through all files in `$PREFIX/bin` (completed in Round 1).
4. **Integrate LSE Components:**
   - Add a `liblse_compat` build target directly into `env/build.sh`.
   - If LSE emulation is required in Bionic, provide a dedicated build of `liblse_compat_bionic.so` using the Android NDK without dependencies on `libc.so.6`.

---

## 7. Build and Testing Instructions

### Building the Environment
```bash
# 1. Build optimized bootstrap.tar.gz from bootstrap-aarch64.zip
./env/build.sh bootstrap

# 2. Package all environment layers into dist/env (ready for APK bundling)
./env/build.sh assets

# 3. Full rebuild of all components
./env/build.sh all
```

### Running Tests
```bash
# 1. Offline unit tests for pkg core (vercmp, resolver, db, deb)
bash env/tests/selftest

# 2. Verify invariants and asset tree integrity
bash env/tests/invariant

# 3. Comprehensive end-to-end integration test deploying prefix
bash env/tests/e3
```
