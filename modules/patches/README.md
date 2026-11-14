# Antigravity Core Binary Patcher (`modules/patches`)

Targeted binary patching module for the Antigravity `language_server` core targeting the **Android ARM64 (aarch64)** architecture. Bypasses platform constraints (Android seccomp filters, Bionic libc assumptions, lack of hardware LSE atomics on ARMv8.0-A) and facilitates seamless runtime integration.

---

## 1. Architecture

```
modules/patches/
├── pipeline.py              # CLI runner and programmatic pipeline API
├── spec/
│   └── patch_manifest.json  # Specification of expected patches and policies
├── engine/                  # Low-level analysis and modification engines
│   ├── elf_scanner.py       # ELF64/AArch64 parser and .text section locator
│   ├── pclntab_scanner.py   # Go pclntab function table parser and MOVZ encoder
│   ├── byte_replacer.py     # In-place search and byte pattern replacer
│   ├── reporter.py          # JSON report generator for applied patches
│   └── patch_context.py     # Execution context model
├── groups/                  # Functional patch implementations
│   ├── gates/               # CLI gate and Enterprise Auth bypasses
│   ├── syscalls/            # Retargeting seccomp-blocked faccessat2/fchmodat2
│   ├── sigill/              # Protecting SIGILL signal handler (for liblse_compat)
│   ├── resolv/              # Redirecting /etc/resolv.conf to relative path
│   └── failfast/            # Suppressing ARMv8.0-A CPU checks and preinit atomics
└── tests/                   # Unit and integration test suite
    ├── test_byte_replacer.py
    ├── test_elf_scanner.py
    ├── test_pclntab_scanner.py
    ├── test_full_pipeline.py
    └── run_all.sh
```

---

## 2. Patch Groups

| Group | Module | Target & Signature | Action |
|---|---|---|---|
| **gates** | `cli_gate` | `ldrb w1, [x0,#8]` in CLI gate check | Replaced with `mov w1, #1` (`21 00 80 52`) |
| **gates** | `enterprise_auth` | `EnterpriseAuthValidator.Validate` | Forces positive validation return flag |
| **syscalls** | `faccessat` | `syscall.faccessat2` (sys_439: `0xd28036e0`) | Retargeted to `faccessat` (sys_48: `0xd2800600`) |
| **syscalls** | `fchmodat` | `syscall.fchmodat2` (sys_452: `0xd2803880`) | Retargeted to `fchmodat` (sys_53: `0xd28006a0`) |
| **sigill** | `sigill_handler` | `rt_sigaction` invocation in Go runtime | Ignores `SIGILL` (signal 4) to preserve `liblse_compat.so` handler |
| **resolv** | `resolv_redirect` | String literal `/etc/resolv.conf` (16 bytes) | Replaced with `etc//resolv.conf` without changing byte length |
| **failfast** | `crash_suppressor` | ARMv8.0-A CPU feature check (`0x7701180`) & preinit atomic (`0x7765c60`) | Injects branch `b +0x64` to bypass LSE/CRC/AES checks and replaces `ldaddal` with `ldr`/`str` for full compatibility with ARMv8.0-A CPUs (Snapdragon 660, etc., lacking hardware LSE) |

---

## 3. Analysis Engine Optimizations (Round 1)

1. **`elf_scanner.py`**:
   - Direct validation of `e_ident` header at offset 0 with support for embedded ELF container search.
   - Stripped binary support (`e_shnum == 0`): automatic fallback to Program Headers (`PT_LOAD` with `PF_X` flag).
   - Strict offset and size boundary verification for `.text`, `.shstrtab`, and header tables.
2. **`pclntab_scanner.py`**:
   - Optimized `find_function`: direct lookup of function name position within the `funcnametab` string table.
   - Internal result caching (`_cache`) in the pclntab context, eliminating loops that decoded tens of thousands of latin-1 strings on every syscall patch.
3. **Zero-Copy Across Patch Groups**:
   - Complete removal of intermediate `bytes(data)` allocations in scanning loops; operates directly via the Python buffer protocol (`bytearray` / `memoryview`).
   - Eliminated verification bypass in `crash_suppressor.py`: strict enforcement of fail-closed policy.

---

## 4. CLI & Python API

### CLI Runner
```bash
# Apply all patches to binary:
python3 modules/patches/pipeline.py /path/to/language_server

# Save patch execution report to manifest:
python3 modules/patches/pipeline.py /path/to/language_server --manifest report.json

# Check patch presence (exit code 0 / 1):
python3 modules/patches/pipeline.py /path/to/language_server --verify

# Dry-run execution without modifying file on disk:
python3 modules/patches/pipeline.py /path/to/language_server --dry-run

# Tolerate missing patch signatures:
python3 modules/patches/pipeline.py /path/to/language_server --allow-missing
```

### Python API
```python
import pipeline

ok = pipeline.run_pipeline(
    target_path="/path/to/language_server",
    verify=False,        # Verification only mode
    dry_run=False,       # Dry run without disk writes
    allow_missing=False, # Do not fail on absent signatures
    manifest_path=None   # Output JSON manifest path
)
```

---

## 5. Testing

Execute the comprehensive test suite:
```bash
bash modules/patches/tests/run_all.sh
```

- `test_byte_replacer.py`: Unit tests for byte pattern matching and in-place replacement.
- `test_elf_scanner.py`: ELF64 validation, Program Header fallback for stripped binaries, and boundary checks.
- `test_pclntab_scanner.py`: Validates AArch64 `MOVZ X0, #imm` opcode encoding, direct search in `funcnametab`, and caching.
- `test_full_pipeline.py`: End-to-end integration test on pristine `language_server` binary (dry-run, apply, sha256 check, verify, idempotence, fail-closed validation).
