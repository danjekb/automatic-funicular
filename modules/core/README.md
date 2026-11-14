# Antigravity Core Module (`modules/core`)

> Foundational distribution module for the Antigravity v2 core: unpacking, AArch64 ELF/ABI validation, glibc environment provisioning, system shims, and cryptographic runtime directory assembly.

---

## 1. Purpose and Responsibilities

The `modules/core` module serves as the runtime foundation for Antigravity v2 on the Android platform (ARM64 / AArch64). It delivers the upstream language server binary, glibc shared libraries, certificates, configurations, and provides tooling for:

1. **Unpacking and Extraction (`unpack/`):** Detecting archive formats (tar.gz / raw ELF) and extracting `language_server` with proper POSIX permissions.
2. **Binary Validation (`validate/`):** Verifying SHA-256 checksums, validating 64-bit Little-Endian ELF headers, confirming AArch64 target architecture (EM=183), and checking binary types (ET_DYN/PIE).
3. **Cryptographic Manifesting (`manifest/`):** Streaming SHA-256 hashing (1 MB chunks), generating `manifest.json`, and strictly validating file integrity.
4. **Runtime Bundle Assembly (`bundle/`):** Building an isolated runtime directory (`bin/`, `lib/`, `certs/`, `seed/`) for downstream consumers (`modules/runner`, `modules/builder`).
5. **System Shims (`shims/`):** Emulating Linux environment utilities (`xdg-open`, browser dispatchers, Shizuku `rish`).

---

## 2. Directory and File Structure

```
modules/core/
├── spec/                       # Declarative core specifications
│   ├── version.env             # Version variables, build tag, loader filename
│   ├── checksums.json          # Reference SHA-256 hashes and archive/binary sizes
│   ├── glibc_deps.list         # Required glibc .so library dependencies
│   └── shims.list              # Executable shims to install
├── pristine/                   # Original unaltered core archive
│   └── language_server.tar.gz  # Pristine aarch64 language_server (~181 MB unpacked)
├── unpack/                     # Extraction and file permissions modules
│   ├── archive_detector.py     # Format detector (tar_gz, elf, unknown)
│   ├── extractor.py            # Extracts core binary from tar.gz / raw ELF
│   └── permissions.py          # Configures POSIX permissions (+x / +r)
├── validate/                   # ELF and checksum validators
│   ├── elf_header.py           # Validates \x7fELF magic, EI_CLASS (64-bit), EI_DATA (LE)
│   ├── elf_arch.py             # Validates e_machine == EM_AARCH64 (183)
│   ├── elf_compat.py           # Validates e_type (ET_EXEC / ET_DYN)
│   ├── checksum_checker.py     # Streaming SHA-256 verification against baselines
│   └── verify_pipeline.py      # End-to-end 5-stage validation pipeline
├── manifest/                   # Manifest generator and validator
│   ├── file_hasher.py          # Streaming SHA-256 calculation (1 MB buffer)
│   ├── manifest_builder.py     # Scans directory and compiles manifest.json
│   └── manifest_verifier.py    # Verifies directory integrity against manifest.json
├── bundle/                     # Final runtime packager
│   ├── layout.py               # Initializes directory layout (bin, lib, certs, seed, etc.)
│   ├── pack_binaries.py        # Packages language_server, loader, and shims into bin/
│   ├── pack_libraries.py       # Copies glibc libraries to lib/ and network configs to etc/
│   ├── pack_certs.py           # Copies SSL CA certificates to certs/
│   ├── pack_seed.py            # Copies initial seed state files to seed/
│   └── assemble.py             # CLI and Python orchestrator for full runtime assembly
├── glibc/                      # AArch64 glibc library distribution
│   ├── ld-linux-aarch64.so.1   # Dynamic linker (ELF interpreter)
│   ├── libc.so.6, libm.so.6... # Glibc system libraries
│   ├── liblse_compat.so        # LSE atomic instruction emulator for older CPUs
│   └── etc/                    # Configuration files (hosts, nsswitch, resolv)
├── certs/                      # Security certificates
│   └── ca-certificates.crt     # System SSL CA certificate bundle
├── seed/                       # Initial configuration and instructions
│   ├── AGENTS.md               # System prompt and environment rules
│   └── *.pbtxt                 # Initial onboarding protobuf state files
├── shims/                      # System and browser stubs
│   ├── browser/                # xdg-open and browser dispatchers (chrome, open, etc.)
│   ├── privilege/              # rish.sh (interface to Shizuku ADB shell)
│   └── system/                 # open_helper.sh, xdg_open.sh (URL dispatcher)
└── tests/                      # Automated test suite
    ├── test_extractor.py       # Tests for extraction and archive_detector
    ├── test_elf_validator.py   # Tests for ELF headers and target architecture
    ├── test_manifest.py        # Tests for manifest generation and corruption detection
    ├── test_bundle.py          # Tests for layout, etc-configs, and assemble.py
    ├── test_shims.py           # Tests for URL parsing in xdg-open and browser shims
    └── run_all.sh              # Syntax check and test runner script
```

---

## 3. Component Interfaces (API & CLI)

### 3.1. Unpacking (`unpack/`)

- **`extractor.extract_core(src_path: str, dest_path: str, binary_name: str = "language_server") -> bool`**
  - Extracts the `binary_name` executable from `tar.gz` or copies a raw `ELF`.
  - CLI: `python3 extractor.py <source_path> <dest_binary_path> [binary_name]`

- **`archive_detector.detect_type(file_path: str) -> str`**
  - Returns: `"tar_gz"`, `"elf"`, `"unknown"`, `"not_found"`.
  - CLI: `python3 archive_detector.py <file_path>`

- **`permissions.make_executable(file_path: str) -> None`**
  - Applies `r-xr-xr-x` permissions to the file.
  - CLI: `python3 permissions.py [--exec|--read] <path>`

### 3.2. Validation (`validate/`)

- **`elf_header.validate_elf_header(file_path: str) -> bool`**
  - Validates `\x7fELF` magic, 64-bit (`EI_CLASS=2`), and Little-Endian (`EI_DATA=1`).
- **`elf_arch.validate_aarch64(file_path: str) -> bool`**
  - Verifies `e_machine == 183` (ARM64/AArch64).
- **`elf_compat.validate_executable_type(file_path: str) -> str`**
  - Returns `"ET_DYN"` (PIE/SO) or `"ET_EXEC"`.
- **`checksum_checker.verify_checksum(file_path: str, expected_hash: str) -> bool`**
  - Computes streaming SHA-256 (1 MB buffer) and validates against reference hash.

### 3.3. Manifest (`manifest/`)

- **`manifest_builder.build_manifest(runtime_dir: str, out_file: str = None) -> dict`**
  - Recursively scans `runtime_dir` (excluding `manifest.json` itself), computes SHA-256 for each file, and produces structured JSON:
    ```json
    {
      "schema": 1,
      "generated_at": "2026-10-15T20:00:00Z",
      "files": {
        "bin/liblanguage_server.so": "<sha256>",
        "lib/libc.so.6": "<sha256>"
      }
    }
    ```
  - CLI: `python3 manifest_builder.py <runtime_dir> [output_manifest_path]`

- **`manifest_verifier.verify_manifest(manifest_path: str, target_dir: str) -> bool`**
  - Validates existence and SHA-256 checksum matching for all files declared in the manifest.
  - CLI: `python3 manifest_verifier.py <manifest_json_path> <target_dir>`

### 3.4. Bundle Assembly (`bundle/`)

- **`assemble.assemble_runtime(core_bin_path: str, module_root: str, out_dir: str, dry_run: bool = False) -> dict`**
  - Orchestrates runtime assembly:
    1. Initializes directories (`layout.py`), including `bin`, `lib`, `certs`, `seed`, and `etc`.
    2. Copies the core as `bin/liblanguage_server.so`, loader as `bin/libloader.so` and `bin/ld-linux-aarch64.so.1`, and installs shims (`pack_binaries.py`). Browser dispatchers are symlinked or linked as compact wrappers pointing to `xdg-open`.
    3. Copies shared libraries into `lib/`, and network/DNS configurations (`hosts`, `resolv.conf`, `nsswitch.conf`) from `glibc/etc` to `etc/` (`pack_libraries.py`), avoiding duplicate loader copies.
    4. Copies root certificates to `certs/` (`pack_certs.py`).
    5. Copies seed state files to `seed/` (`pack_seed.py`).
    6. Generates `manifest.json` (`manifest_builder.py`).
  - CLI:
    ```bash
    python3 modules/core/bundle/assemble.py \
      --core-bin /path/to/language_server \
      --out-dir /path/to/destination/runtime \
      [--dry-run]
    ```

---

## 4. Structure of Assembled Runtime (`assets/runtime`)

Upon completion, the module produces a runtime directory with the following layout:

| Directory | Contents | Purpose |
| :--- | :--- | :--- |
| `bin/` | `liblanguage_server.so`, `libloader.so`, `ld-linux-aarch64.so.1`, `xdg-open`, `chrome`, `rish`... | Executable binaries, Glibc dynamic loader, and shell shims |
| `lib/` | `libc.so.6`, `libm.so.6`, `libdl.so.2`, `libpthread.so.0`, `liblse_compat.so`, `ld-linux-aarch64.so.1` | Glibc dependencies and AArch64 LSE atomic emulation |
| `etc/` | `hosts`, `resolv.conf`, `nsswitch.conf` | Network and DNS configuration files required by Glibc resolver |
| `certs/` | `ca-certificates.crt` | Root SSL/TLS certificates for Go TLS runtime |
| `seed/` | `AGENTS.md`, `antigravity_state.pbtxt`, `jetski_state.pbtxt` | Onboarding presets, agent configuration, and system instructions |
| `/` | `manifest.json` | Cryptographic integrity registry for all runtime files |

---

## 5. Testing and Validation

### Full Unit Test Suite
```bash
bash modules/core/tests/run_all.sh
```
Executes:
1. Python syntax compilation (`compileall`) and shell syntax validation (`bash -n`).
2. Extraction and archive detection unit tests (`test_extractor.py`).
3. ELF header and architecture validation unit tests (`test_elf_validator.py`).
4. Manifest generation and corruption detection unit tests (`test_manifest.py`).
5. Bundle assembly, layout, and configuration unit tests (`test_bundle.py`).
6. URL parsing and browser shim delegation unit tests (`test_shims.py`).

### End-to-End Verification Pipeline
```bash
python3 modules/core/validate/verify_pipeline.py
```
Performs a 5-stage end-to-end validation in an isolated sandbox: pristine archive hash verification -> extraction -> ELF/ABI validation -> test runtime assembly -> manifest integrity verification.
