# APK Builder Module: `modules/builder`

> Autonomous Android APK build pipeline without Gradle or Android Studio.
> Optimized for native execution directly inside the Android environment (ARM64 / Linux).

---

## 1. Architecture Overview

The Singularity APK build process runs completely independently of heavy build frameworks (Gradle, AGP, Groovy/Kotlin daemon). The orchestrator [`build_apk.sh`](build_apk.sh) executes a sequence of atomic scripts, directly driving low-level Android SDK binary tools (`aapt`, `javac`, `d8`/`r8`, `zipalign`, `apksigner`) and specialized Python utilities.

### Pipeline Diagram

```mermaid
flowchart TD
    Env[config/app.env] --> P01[01_gen_config.py]
    Src[app/src/main/...] --> P01
    
    subgraph Config & Resources
        P01 -->|BuildConfig.java| GenDir[build/gen]
        P01 -->|gen.xml| BuildRes[build/res/values]
        P01 -->|Dev-aware Manifest| TargetManifest[build/AndroidManifest.xml]
        TargetManifest & ResDir[app/src/main/res] & BuildRes --> P02[02_r_java.sh: aapt overlay]
        P02 -->|R.java| GenDir
    end

    subgraph Bytecode & Dexing
        GenDir & Src --> JavaArg[@build/java_sources.txt]
        JavaArg --> P03[03_compile_java.sh: javac]
        P03 -->|*.class| ObjDir[build/obj]
        ObjDir --> ClassArg[@build/class_files.txt]
        ClassArg --> P04[04_dex.sh: D8 via r8.jar]
        P04 -->|classes.dex| DexDir[build/dex]
    end

    subgraph Assets & Packaging
        Runtime[modules/runner/prepare_runtime] --> P05[05_stage_assets.py]
        Web[web/] & EnvDist[env/dist] --> P05
        P05 -->|staged assets| StagingDir[build/staging/assets]
        
        TargetManifest & ResDir & BuildRes & StagingDir & DexDir --> P06[06_package.sh: aapt + zip]
        P06 -->|raw APK| Unaligned[build/unaligned.apk]
    end

    subgraph Align, Sign & Verify
        Unaligned --> P07[align.py: zipalign / python]
        P07 -->|4-byte aligned APK| Aligned[build/aligned.apk]
        Aligned --> P08[08_sign.sh: apksigner]
        P08 -->|Signed APK (v1+v2+v3)| Dist[dist/singularity.apk / singularity-dev.apk]
        Dist --> P09[09_verify.sh: apksigner verify]
    end
```

---

## 2. Build Pipeline Stages

| Stage | Script | Primary Tool | Inputs | Outputs | Purpose |
|---|---|---|---|---|---|
| **01** | [`01_gen_config.py`](01_gen_config.py) | Python 3 | `config/app.env`, `AndroidManifest.xml` | `build/gen/**/BuildConfig.java`, `build/res/values/gen.xml`, `build/AndroidManifest.xml` | Generates constants, ports, and dev-manifest into the build tree (without dirtying git) |
| **02** | [`02_r_java.sh`](02_r_java.sh) | `aapt` | `AndroidManifest.xml`, `res/`, `build/res/`, `android.jar` | `build/gen/**/R.java` | Compiles resource IDs with overlay support, skipping duplicate generation in release builds |
| **03** | [`03_compile_java.sh`](03_compile_java.sh) | `javac` | `@build/java_sources.txt`, `android.jar` | `build/obj/**/*.class` | Compiles Java sources via an argument file (preventing `ARG_MAX` overflow) |
| **04** | [`04_dex.sh`](04_dex.sh) | `D8` (`tools/r8.jar`) | `@build/class_files.txt`, `android.jar` | `build/dex/classes.dex` | Translates Java bytecode to DEX via a D8 argument file without CLI length overflow |
| **05** | [`05_stage_assets.py`](05_stage_assets.py) | Python 3 + `modules/runner` | Runtime core, `web/`, `env/dist/env` | `build/staging/assets/` | Stages and validates assets (runtime, web, env) |
| **06** | [`06_package.sh`](06_package.sh) | `aapt` + `zipfile` | Resources + overlay `build/res`, manifest, `classes.dex`, `staging/assets/` | `build/unaligned.apk` | Builds baseline APK with resource overlay and injects dex and assets |
| **07** | [`align.py`](align.py) | `zipalign` / Python | `build/unaligned.apk` | `build/aligned.apk` | 4-byte ZIP alignment for optimal Android `mmap` performance |
| **08** | [`08_sign.sh`](08_sign.sh) | `apksigner` | `build/aligned.apk`, `tools/debug.keystore` | `dist/singularity.apk` or `dist/singularity-dev.apk` | Signs APK with v1, v2, and v3 signature schemes |
| **09** | [`09_verify.sh`](09_verify.sh) | `apksigner` | `dist/*.apk` | Verification report to stdout | Full validation of APK signature integrity and scheme compliance |

---

## 3. Detailed Step Breakdown

### Step 01: Configuration Generation (`01_gen_config.py`)
- **Inputs**: Environment variables from `config/app.env` and `DEV_MODE` (0 or 1).
- **Outputs**:
  - `build/gen/dev/singularity/antigravity/BuildConfig.java`: static fields `PORT`, `GATEWAY_PORT`, `CORE_VERSION`, `APP_VERSION_NAME`, and `DEBUG`.
  - `build/res/values/gen.xml`: string and integer XML resources for the Android framework (generated inside the build tree, keeping repository working tree and `git status` clean).
  - `build/AndroidManifest.xml`: substitutes `${applicationId}`, and in dev mode rewrites the package name to `dev.singularity.antigravity.dev`, enables `android:debuggable="true"`, and isolates `permission.INTERNAL_BROADCAST`.

### Step 02: R.java Generation (`02_r_java.sh`)
- Runs `aapt package -m -J <gen_dir>` to parse resources and create numeric IDs with resource overlay support: `-S "$BUILD_DIR/res" -S "$RES_DIR" --auto-add-overlay`.
- Inspects the package name in the target manifest: if the package matches the default `dev.singularity.antigravity`, the secondary duplicate `aapt` invocation is skipped. If the package name differs (e.g. `dev.singularity.antigravity.dev`), a secondary fallback `dev.singularity.antigravity.R` is generated via `--custom-package dev.singularity.antigravity` for legacy invocation compatibility.

### Step 03: Java Compilation (`03_compile_java.sh`)
- Gathers the list of application sources and generated classes (`BuildConfig`, `R`) into an argument file `@$BUILD_DIR/java_sources.txt`, eliminating the risk of `ARG_MAX` (`Argument list too long`) errors.
- Compiles source code with `javac`: `-encoding UTF-8 -source 1.8 -target 1.8 -cp tools/android.jar @$BUILD_DIR/java_sources.txt`.

### Step 04: D8 Dexing (`04_dex.sh`)
- Scans the compiled class directory `$OBJ_DIR` and generates an argument file `@$BUILD_DIR/class_files.txt`, removing command-line length limitations.
- Converts compiled `.class` files into `classes.dex` using standalone D8 (`com.android.tools.r8.D8` from `tools/r8.jar`).
- Arguments: `--output $DEX_DIR`, `--lib tools/android.jar`, `--min-api 24`, `@$BUILD_DIR/class_files.txt`.

### Step 05: Asset Staging (`05_stage_assets.py`)
- Collects three resource bundles into `build/staging/assets/`:
  1. `runtime/`: the `language_server` binary core (patched and cryptographically verified via `prepare_runtime.py`).
  2. `web/`: frontend web interface (`index.html`, `compiled_tailwind.css`, `generated/main.js`, etc.). Before copying, automatically triggers `bash web/build.sh` to ensure bundle freshness from `web/src/`. Excludes development files (`main.js`, `src/`, `tests/`, `build.sh`, `patch_main.py`, and `src.manifest`) via the `web_ignore` filter.
  3. `env/`: userspace overlays, `libtermux-exec.so`, and `manifest.json`.

### Step 06: APK Packaging (`06_package.sh`)
- `aapt package -f` constructs the APK skeleton with resource overlay support (`-S "$BUILD_DIR/res" -S "$RES_DIR" --auto-add-overlay`), binary `AndroidManifest.xml`, and compiled resources (`resources.arsc`).
- A streaming Python ZIP injector appends `classes.dex` and the `assets/` tree.
- Files already compressed with gzip/png/jpeg/zip algorithms are stored uncompressed (`ZIP_STORED`), while remaining files are compressed via `ZIP_DEFLATED`.

### Step 07: ZipAlign Alignment (`align.py`)
- Aligns uncompressed data headers on 4-byte boundaries (and 4096-byte boundaries for `.so` shared libraries), enabling the Android OS to access files directly via `mmap()` without allocating decompression buffers in RAM.
- **Two-Tier Strategy**:
  1. System `zipalign` binary (if available in `$PATH`).
  2. Built-in, cross-platform pure-Python alignment engine without external dependencies.

### Steps 08 and 09: Signing and Verification (`08_sign.sh` & `09_verify.sh`)
- `apksigner sign` signs the APK using keys from `tools/debug.keystore`.
- Supported signing schemes:
  - **v1**: JAR signature (backward compatibility).
  - **v2**: APK Signature Scheme v2 (Android 7.0+).
  - **v3**: APK Signature Scheme v3 (Android 9.0+).
- `apksigner verify --verbose` verifies signature validity and manifest digests.

---

## 4. Dependencies and Tools

| Tool | Minimum Version | Purpose | Location |
|---|---|---|---|
| **Python** | 3.8+ | Configuration, staging, packaging, ZipAlign | System `$PATH` |
| **aapt** | v0.2+ (v1) | XML parsing, resource compilation, APK skeleton | System `$PATH` |
| **javac** | OpenJDK 8 / 11 / 17 | Compiling `.java` -> `.class` | System `$PATH` |
| **java** | JRE 8+ | Running R8/D8 | System `$PATH` |
| **r8.jar** | Android R8/D8 | Dexer (bytecode -> DEX) | `tools/r8.jar` |
| **android.jar** | API 24+ (target API 28) | Android Framework Stubs | `tools/android.jar` |
| **zipalign** | Any (optional) | Fast native ZIP alignment | System `$PATH` |
| **apksigner** | 0.9+ | APK signing and verification | System `$PATH` |
| **debug.keystore**| JKS/PKCS12 | Test signing certificate | `tools/debug.keystore` |

---

## 5. Usage

```bash
# Standard release APK build (dist/singularity.apk, port 45167):
bash modules/builder/build_apk.sh

# Dev APK build (dist/singularity-dev.apk, port 45168):
DEV_MODE=1 bash modules/builder/build_apk.sh

# Run builder module test suite:
bash modules/builder/tests/run_all.sh
```

---

## 6. Audit Findings: Bugs, Workarounds, and Optimizations

### 1. Critical Bug in `align.py` (Resolved)
- **Problem**: In the pure-Python `align_with_python` implementation, the `zin.read()` method was invoked for each archive entry. This method decompresses `ZIP_DEFLATED` streams. The decompressed bytes were then written to the output file while retaining original headers with `compress_type=8` and original `compress_size`. As a result, when the `zipalign` binary was unavailable, generated APKs were corrupted (`zlib.error: invalid stored block lengths`).
- **Fix**: Rewrote the routine to stream raw compressed bytes directly (`raw payload`) based on local header offsets using 64 KB chunked buffering. Archive corruption was eliminated, and RAM usage dropped from O(N) to O(1).

### 2. Source Tree Pollution (`gen.xml`) (Resolved)
- **Problem**: `01_gen_config.py` wrote `gen.xml` directly into the repository directory `app/src/main/res/values/gen.xml`, polluting `git status` and risking accidental commits of dev configuration.
- **Fix**: Relocated generation to the build tree `$BUILD_DIR/res/values/gen.xml`. Added resource overlay support `-S "$BUILD_DIR/res" -S "$RES_DIR" --auto-add-overlay` to `02_r_java.sh` and `06_package.sh`, allowing generated values to be injected dynamically while keeping the Git working tree clean.

### 3. Redundant `aapt` Pass in `02_r_java.sh` (Resolved)
- **Problem**: In release mode, `aapt` executed twice with identical parameters (`dev.singularity.antigravity`), generating unnecessary CPU overhead.
- **Fix**: Added manifest inspection to `02_r_java.sh` (`PKG=$(sed -n -E 's/.*package="([^"]+)".*/\1/p' "$MANIFEST" | head -n 1)`). If the target package is already `dev.singularity.antigravity`, the duplicate run is skipped. If the package differs (e.g. `dev.singularity.antigravity.dev`), both packages are generated (`dev.singularity.antigravity.dev.R` and compatibility fallback `dev.singularity.antigravity.R`).

### 4. Command Line Overflow Risk (`ARG_MAX`) (Resolved)
- **Problem**: In `03_compile_java.sh` and `04_dex.sh`, source files and classes were expanded directly into bash arrays `${JAVA_SOURCES[@]}` and `${CLASS_FILES[@]}`. As the codebase grew, this caused Linux kernel `Argument list too long` (`E2BIG`) errors.
- **Fix**:
  - For `javac` in `03_compile_java.sh`: generated an argument file `@$BUILD_DIR/java_sources.txt` containing escaped paths.
  - For `D8` in `04_dex.sh`: scanned `$OBJ_DIR` and generated an argument file `@$BUILD_DIR/class_files.txt` passed to `com.android.tools.r8.D8` (resolving command length limits and working around D8 incompatibilities with raw directory paths).

### 5. Multiple JVM Invocations (JVM Overhead)
- **Problem**: The pipeline invokes the Java Virtual Machine 4 consecutive times (`javac`, `d8`, `apksigner sign`, `apksigner verify`). On mobile CPUs, each JVM startup takes 0.8–1.5 seconds.
- **Recommendation**: Combine the signing and verification steps, or implement a unified build runner / daemon.

### 6. Non-functional `--fast` Flag
- **Problem**: The `--fast` flag was parsed in `build_apk.sh` but never propagated to child scripts. On every execution, the `build/` directory was completely deleted (`rm -rf`), forcing repeated copying and repacking of ~240 MB of assets.
- **Recommendation**: Forward `FAST_BUILD` to `05_stage_assets.py` and `06_package.sh` to enable incremental asset packaging and skip unmodified core binaries.

### 7. Redundant Disk I/O on Flash Storage
- **Problem**: Full APK disk writes occur 3 times consecutively: `unaligned.apk` (~103 MB) -> `aligned.apk` (~103 MB) -> `dist/singularity.apk` (~103 MB). Writing over 300 MB per build cycle causes unnecessary flash storage wear on Android devices.
- **Recommendation**: Output `align.py` directly into the final target `$DIST_DIR/singularity.apk` and sign it in-place.

### 8. Web Build Integration and Manifest Leak Prevention (Resolved)
- **Problem**: In `05_stage_assets.py`, web assets were copied "as-is" from `web/` without triggering a prior build, which risked shipping stale assets when `web/src/` changed. Additionally, `src.manifest` was missing from `web_ignore`, causing internal source manifests to leak into the APK.
- **Fix**: Injected automatic execution of `bash web/build.sh` prior to asset staging in `05_stage_assets.py`, and added `src.manifest` to the `web_ignore` list.
