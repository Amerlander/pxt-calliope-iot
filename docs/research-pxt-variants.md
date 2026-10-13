# pxt-calliope variants, extension C++ and serial: research for the `iot` extension

Date: 2026-09-29. Scope: what the `calliopemini` target (local checkout, branch `static-hosting`, target version 8.2.3, pxt-core 12.3.7, pxt-common-packages 13.2.3) does with an extension that must run on the Calliope mini 2 (nRF51822, DAL) and the Calliope mini 3 (nRF52833, CODAL). Every claim is marked as one of three kinds:

- **built**: checked by a build in this session (section 6).
- **source**: read in the source at the cited line and not run on hardware.
- **HIL**: open, needs a hardware test (listed in section 9).

No hardware, COM port or drive was touched. The only new files are this document and the temporary build workspace `C:\Users\ms\AppData\Local\Temp\pxtvariants\`. `git status` is clean in `pxt-calliope` and `pxt-grove` after all builds.

## Path legend

| Short | Path | Version used |
|---|---|---|
| `PXC` | `C:\GIT\calliope-dev\editors\makecode\pxt-calliope` | `static-hosting` @ `ac4a5186` |
| `CORE` | `PXC\node_modules\pxt-core\built` | pxt-core 12.3.7 |
| `BASE` | `PXC\node_modules\pxt-common-packages\libs\base` | 13.2.3 |
| `DAL` | `C:\GIT\calliope-dev\firmware\dal\microbit-dal` | tag `v2.2.0-rc6-calliope.rc4`: this is what `calliope-mini/microbit#v2.2.0-rc6-calliope.rc5` pins. The working tree (`ae1b537`) has the same line numbers for everything cited here. Its only difference in `MicroBitSerial.cpp` is line 298. |
| `MB` | `C:\GIT\calliope-dev\firmware\dal\microbit` | tag `v2.2.0-rc6-calliope.rc5` |
| `MBED` | `C:\GIT\calliope-dev\firmware\dal\mbed-classic` | the Calliope fork |
| `TGT` | `C:\GIT\calliope-dev\firmware\dal\target-calliope-mini-classic-gcc` | `open_link` = `e3e80d6` (v1.2.7) |
| `CCORE` | `C:\GIT\calliope-dev\firmware\codal\blocks-runtime\libraries\codal-core` | `448c923`, the same commit the pxt codal build checks out |
| `CNRF` | `C:\GIT\calliope-dev\firmware\codal\blocks-runtime\libraries\codal-nrf52` | `1fbb724`, the same commit the pxt codal build checks out |
| `CMB2` | `C:\GIT\calliope-dev\firmware\codal\codal-microbit-v2` | the checkout is on `tested-bootloader`. pxt uses `v0.3.5-calliope-3-open-link-2` (`e0e5266`), which differs only in `lib/bootloader.o`. |
| `GROVE` | `C:\GIT\calliope-dev\editors\makecode\pxt-grove` | branch `iot` @ `d7ac97e` |
| `TMP` | `C:\Users\ms\AppData\Local\Temp\pxtvariants` | build workspace from this session |

---

## 0. Key findings

1. **One hex per board. There is no universal hex.** The target has no `multiVariants`, so a project builds for exactly one variant. That variant is chosen by the project's core package: `v1` → `minidalusb`, `v2` → `minidal`, `v3` → `minicodal`. (built)
2. **Adding any `.cpp` to the extension changes how mini 2 builds work.** Without C++, a mini 2 program links against a precompiled runtime from `PXC\built\hexcache`: no network, about 3 s. With C++, every board needs a cloud compile: about 100–120 s the first time for each distinct C++ configuration, then cached. (built)
3. **Cloud-compiled mini 2 hexes carry a different bootloader.** The cloud's DAL service ignores the `#open_link` `yottaTarget`. Its hexes contain the original 2017 Nordic bootloader from the Calliope target (`9f51e34`, the same bytes as tag `v1.2.4`). A local `#open_link` build carries the stack reference `v1.1.2-calliope-webdfu`. Only five local hexcache images, built on 2026-06-03, carry `v1.1.1-calliope-webdfu`. So shipping C++ in the extension changes the bootloader of every mini 2 flashed with an `iot` program. (built) Section 10 has the root cause and the fix; it corrects some details of this item.
4. **Flash is the tightest limit on mini 2.** All TypeScript together (user program, the used core libraries and the extension) gets about 22 KB. A test program using the current `pxt-grove#iot` IoT blocks fails for v2 with `program too big by 3224 bytes`. On v3 the same program is 25.7 KB of code. (built)
5. **The largest single allocation on mini 2 is probably about 248 bytes when BLE is on.** On DAL the pxt GC grows in 256-byte blocks (`GC_BLOCK_SIZE 256`). It only gets one large block when the SoftDevice RAM is free, which happens only with BLE off. By this reading, a string longer than about 241 characters, an array with more than 32 elements or a buffer larger than about 240 bytes ends in panic 021 on a mini 2 with BLE on (the default). (source, **HIL**)
6. **Serial differs a lot between the two runtimes.** Key points:
   - Buffer sizes are `uint8_t` on both, so 254 is the safe maximum.
   - On DAL, `setRxBufferSize(255)` (and any TS value ≥ 255) silently turns receiving off.
   - On CODAL, baud rates outside {9600, 31250, 38400, 57600, 115200, 230400, 921600, 1000000} silently become 115200.
   - DAL `readUntil` has a wrap-around bug.
   - On both, a second writer or reader fiber silently gets `IN_USE`, so its data is dropped.
   - On both, `serial.redirect` silently does nothing while any fiber is blocked in `readUntil`/`readLine`. (source)
7. **A second UART on mini 3 is available but shared with Jacdac.** `NRF_UARTE1` is free in the CODAL allocator. Jacdac's `ZSingleWireSerial` also asks for "any UARTE" and receives UARTE1, so using both panics (090) on whichever starts second. (source)
8. **`iotdap.cpp`'s guard is correct and builds on both variants.** The `//%` entry points must stay outside `#if MICROBIT_CODAL`, because the shim scanner does not evaluate `#if`. (built: DAL and CODAL both compile and link.) One comment in `iotdap.cpp` is wrong: mini 2 has 32 KB of RAM, not 16 KB (16 KB is mini 1).
9. **No RAM mailbox on mini 2.** Its SEGGER J-Link OB (VID 0x1366) gives the browser MSD image programming and CDC serial, but no CMSIS-DAP memory access. In WiFi mode the CDC serial is the same UART as the WiFi module, so it is not available. (source)
10. **Local builds for HIL:**
    - The temp-workspace recipe works.
    - Mini 3 local docker builds work: 11 min cold, about 4 min incremental on Windows. Both are slower than the cloud (about 2 min cold).
    - Mini 2 `pxt build --localbuild` is broken on Windows (docker arguments are mangled by `cmd.exe`). Running the same docker command by hand works (6.6 min), but the result is 5 KB larger than the cloud build, so it gives the wrong flash picture. (built)

---

## 1. How pxt-calliope selects the board variant

### 1.1 Packages and variants

| Project dependency | Package manifest | `compileServiceVariant` | Variant in `pxtarget.json` | Result |
|---|---|---|---|---|
| `v1` (mini 1) | `PXC\libs\v1\pxt.json:5-9` | `minidalusb` | `PXC\pxtarget.json:210-217` (webUSB on) | DAL, yotta config `sram_end 0x20004000`, `RAM_SIZE "16K"`, BLE disabled (`v1/pxt.json:20-34`) |
| `v2` (mini 2) | `PXC\libs\v2\pxt.json:5-9` | `minidal` | `PXC\pxtarget.json:202-209` (webUSB off, because the J-Link OB is not CMSIS-DAP) | DAL, `sram_end 0x20008000`, `RAM_SIZE "32K"` (`v2/pxt.json:18-25`), BLE stays on |
| `v3` (mini 3) | `PXC\libs\v3\pxt.json:5-9` | `minicodal` | `PXC\pxtarget.json:218-241` | CODAL, `buildEngine: codal`, `codalTarget` = `calliope-edu/codal-microbit-v2#v0.3.5-calliope-3-open-link-2`, `serviceId mbcodal2`, `yottaConfigCompatibility: true` |
| only `core` | none | none | base `compileService` (`PXC\pxtarget.json:192-199`) | DAL **without** `RAM_SIZE`, so the target falls back to a 16 KB image (`TGT\CMake\toolchain.cmake:8-10`). This was checked: the `coreonly` build's initial SP is `0x20004000`. |

Other details of the selection:

- `v1`/`v2`/`v3` are `"core": true` packages. `core-mini-dal` / `core-mini-codal` are pulled in by them and are `disablesVariants`-guarded (`PXC\libs\core-mini-dal\pxt.json:7`, `core-mini-codal\pxt.json:8`).
- When a package loads, `compileServiceVariant` switches the app variant (`CORE\pxtlib.js:16676-16681`).
- If a project lists several core packages, only the last one is kept (`patchCorePackage`, `CORE\pxtlib.js:16587-16611`).
- `pxtarget.json:7` sets `corepkg: "v1"`.
- The board choice ends up as a `v1`/`v2`/`v3` dependency in the program's `pxt.json`. The editor's hardware list is `PXC\targetconfig.json:670-692`, and `campus-ble-open-link/pxt.json` is a real example with `"v3": "*"`.

**Consequence for testing.** Running `pxt build` inside the extension repo (dependency `core` only) produces a 16 KB-RAM DAL image with BLE on. That image matches no real board configuration, so it must not be used for HIL. Always build per-board test projects (the `hil.py` `prepare_project` already does this).

### 1.2 No multi-variant, no universal hex

- `built/target.json` has no `multiVariants` and no `alwaysMultiVariant`.
- So `getCompileOptionsAsync` takes the single-variant branch `variants = [null]` (`CORE\pxtlib.js:17146-17170`) and emits one hex per build.
- The hex contains no Universal Hex block records (types 0x0A–0x0D). The record types present are 0x00, 0x01, 0x04, 0x05 (v2) or 0x03 (v3), and 0x0E. The 0x0E records come after the EOF record and hold the LZMA-compressed source for re-import (built, section 6.4).

### 1.3 How C++ is compiled

The decision is made in `CORE\cli.js:3021-3046`. It uses a SHA over all C++/header files, the generated `pointers.cpp`, `main.cpp`, the yotta/codal config and the compile service id and tag (`CORE\pxtlib.js:7640-7652`). The steps, in order:

1. **`PXC\built\hexcache\<sha>.hex`**: precompiled runtimes for the bundled packages only. Any program without extension C++ and without extra yotta config hits this cache (built: `v1plain`, `v2plain`, `v3plain`, `coreonly`).
2. **`~/.pxt/cache/hex-<sha>`**: the CLI's cache of earlier cloud results (`CORE\pxtlib.js:7995-8030`).
3. **Cloud.**
   - The client looks for `https://cdn.makecode.com/compile/<sha>.hex`.
   - If it is missing, it sends `POST compile/extension` (`CORE\pxtlib.js:7839-7860`).
   - It then polls every 8 s and gives up after 300 s (`maxWait`, `CORE\pxtlib.js:7857-7864`).
   - `forceCloudBuild` is on unless `KS_FORCE_CLOUD=no` (`CORE\cli.js:47`).
4. **Local**, only with `--localbuild` or `PXT_FORCE_LOCAL=1` (`CORE\cli.js:48,73-90,6393-6396`).
   - The build engine is `dockeryotta` or `dockercodal` with image `pext/yotta:update-yotta3` (`CORE\buildengine.js:128-137`).
   - With `PXT_NODOCKER=1` it uses the host `yotta` or `python build.py` instead.
   - With `--localcompileservice` it uses a local copy of the compile service.

**Which bootloader each DAL build path ships (built).** The pxt compile request sends `config: serviceId`, `tag` and the files, but not `yottaTarget` (`CORE\pxtlib.js:7640-7648`). The cloud's `calliope` service therefore builds with its own copy of the target. Comparing the bootloader region `0x3C000–0x3FC00` byte for byte against every revision of `TGT\bootloader\BLE_BOOTLOADER_RESERVED.hex` gives:

| Build path | Bootloader in the mini 2 hex |
|---|---|
| hexcache (program without extension C++) | `fb6eeeb`/`39de4e2`, i.e. `v1.1.1-calliope-webdfu` |
| cloud (program with extension C++, e.g. `grove`) | the initial 2017 bootloader (`9f51e34`, same content as `68e6752`), which is not the webdfu one |
| local docker with `#open_link` HEAD | `e3e80d6` (v1.2.7) |

This contradicts the note in `firmware\BUILD-PROVENANCE.md` that the MakeCode DAL cores ship the webdfu bootloader "via the compile-service cores". That holds only for hexcache builds.

For v3 the codal target (URL and branch) travels inside the generated `codal.json`, so cloud, hexcache and local builds all carry the same DIR2 bootloader (`0x77000–0x7D2D0`, 25,296 B). (built: identical bytes)

### 1.4 What tells C++ which variant it is in

| Symbol / setting | mini 2 (DAL) | mini 3 (CODAL) | Where |
|---|---|---|---|
| `MICROBIT_CODAL` | `0` | `1` | `PXC\libs\core\pxtcore.h:19-26`. It is always defined (0 or 1), so write `#if MICROBIT_CODAL`, not `#ifdef`. |
| `CODAL_CONFIG_H` | undefined | defined | `CCORE\inc\core\CodalConfig.h:30`. `pxtcore.h` includes `MicroBit.h` first and then tests this macro. |
| `GC_BLOCK_SIZE` / `GC_MAX_ALLOC_SIZE` | 256 / 9000 | default 16 KB / 11000 | `pxtcore.h:21-25`, `BASE\gc.cpp:3-9` |
| nRF family | `NRF51`, `TARGET_NRF51_CALLIOPE`, `TARGET_MCU_NRF51_16K_S110` (the "16K" also appears on the 32 KB mini 2, so do not use it to infer RAM size), `__CORTEX_M0` | `NRF52833_XXAA`, `NRF52833`, `TARGET_MCU_NRF52833`, `NRF5`, `S113`, `__CORTEX_M4`, and `NRF52_SERIES` via nrfx `mdk/nrf.h:68-70` | DAL: generated `build.ninja` in `TMP\v2local\built\dockeryt\build\...`. CODAL: `CMB2\target.json:52` |
| RAM size | `YOTTA_CFG_MICROBIT_DAL_RAM_SIZE "32K"` (mini 1: `"16K"`), `MICROBIT_SRAM_END 0x20008000` | `DEVICE_SRAM_END 0x20020000` | `yotta_config.h:47-48` (generated), `CMB2\target.json:15` |
| BLE on/off | `YOTTA_CFG_MICROBIT_DAL_BLUETOOTH_ENABLED` | the same yotta key, mapped to `MICROBIT_BLE_ENABLED` by `CMB2\inc\compat\yotta_cfg_mappings.h:38-40` | |
| `PXT_TARGET` | `"calliopemini"` | `"calliopemini"` | `CORE\pxtlib.js:7518` |
| C++ standard | `-std=c++11` (`TGT\CMake\toolchain.cmake:36`) | `-std=c++11` (`CMB2\target.json:60`) | So `static_assert` and `offsetof` work on both. |

The extension's `pxt.json` feeds C++ config like this:

- **DAL.** `"yotta": {"config": {...}}` becomes yotta `config.json` and `YOTTA_CFG_*` macros.
  - `optionalConfig` supplies defaults.
  - When two packages set the same key to different values, the build fails with an error (`CORE\pxtlib.js:7370-7425`).
- **CODAL.**
  - Every yotta key becomes both a plain definition and a `YOTTA_CFG_`-prefixed one, because `yottaConfigCompatibility: true` (`CORE\pxtlib.js:7514-7517`). A `codal.` prefix becomes `DEVICE_` (`CORE\pxtlib.js:7569`). The generated `TMP\v3local\built\codal.json` shows this.
  - `"codal": {"libraries": [...]}` adds GitHub libraries (`CORE\pxtlib.js:7378-7392`).
- **Both at once.** A DAL setting such as `microbit-dal.bluetooth.enabled: 0` also reaches CODAL through the compat mapping. An extension cannot set a key for one board only.
- **Whole-package exclusion.** `disablesVariants` removes a package from a variant. The program then compiles to a stub hex that panics 927 on the device (`CORE\pxtcompiler.js:16272-16279`, `BASE\pxt.cpp:428,444`). This is not usable for an extension that must run on both boards.

### 1.5 How `iotdap.cpp` guards itself, and whether it is correct

- `GROVE\iotdap.cpp:1` includes `pxt.h`. Lines 63-171 (the struct, the `aligned(1024)` static and the helpers) sit inside `#if MICROBIT_CODAL`.
- Lines 173-187 are `#else` stubs.
- The three `//%` entry points `iotdap::schreibe/lies/hoertJemandZu` (`:189-214`) are **outside** the `#if`.

This is the correct pattern, and it is required:

- The pxt C++ scanner removes only `#if 0`, `#if false` and `#if PXT_UTF8` blocks (`CORE\pxtlib.js:6879,7031-7032`). It registers every `//%` function it sees, regardless of `#if`.
- Every registered function goes into the generated `pointers.cpp` for every variant (`CORE\pxtlib.js:7308-7309`).
- So a `//%` function defined only inside `#if MICROBIT_CODAL` would fail to link on DAL.

Built checks:

- The DAL cloud build (`v2grove`) and the local DAL link both succeed. `iotdap.cpp.o` has 0 bytes of `.bss` on DAL, so no mailbox RAM is spent.
- On CODAL the struct sits at `0x20002400` (the first `.bss` object, 336 B, followed by 176 B of fill; `TMP\v3local\built\dockercodal\build\MICROBIT.map`).
- The TS side (`GROVE\iotdap.ts:28-52`) uses `//% shim=iotdap::…` with TS bodies that return "nothing there", which is what runs in the simulator.

Correction: the comment at `GROVE\iotdap.cpp:56-62` says the mini 2 has 16 KB of RAM. The `v2` package builds with 32 KB (`sram_end 0x20008000`). 16 KB is the mini 1 (`v1`).

---

## 2. Rules for C++ in a pxt extension

- **Declaring.**
  - A C++ function is exported by a `//%` comment line directly above it, inside a `namespace` (top-level functions are an error, `CORE\pxtlib.js:7255-7258`).
  - The scanner is line-based and matches `retType name(args) {` on one line (regex at `CORE\pxtlib.js:7252`).
  - The argument and return types map to TS as follows (`CORE\pxtlib.js:7040-7075`): `int`→`int32`, `uint8_t`→`uint8`, `bool`→`boolean`, `String`→`string`, `Buffer`, `Action`→`() => void`, `TNumber`→`number`, and enums by name.
  - Numbers passed to `uint8_t` are truncated: TS `256` arrives as `0`.
- **`shims.d.ts` / `enums.d.ts` generation.**
  - These are generated only for the **main** package, i.e. when you run `pxt build` in the extension repo itself (`CORE\pxtlib.js:7445-7450`).
  - Only functions that have a `/** … */` doc comment get a declaration (`CORE\pxtlib.js:7277-7300`).
  - The main package must list `shims.d.ts`/`enums.d.ts` in `files`, or the build stops with "please add … to files" (`CORE\pxtlib.js:17094-17102`).
  - Commit the generated files. Dependencies never regenerate them.
- **Hand-written shims instead** (what `iotdap.ts` does).
  - Declare the TS function yourself with `//% shim=ns::fn` and a TS body.
  - On the device the call goes to C++. In the simulator the TS body runs, which is the fallback.
  - When compiling for hardware, a missing C++ symbol fails the compile with `function not found: … (shim=…)`. A wrong arity or procedure/function mismatch also fails (`validateShim`, `CORE\pxtcompiler.js:15655-15681`).
- **`//% shim=TD_NOOP`.**
  - For hardware the call is compiled to nothing. It must return `void`, and its arguments are not evaluated (`CORE\pxtcompiler.js:10889-10897`).
  - The TS body still runs in the simulator.
  - This is how `GROVE\iot.ts:404-466` keeps `control.simmessages` (a simulator-only shim that has no C++) out of device builds.
  - `//% shim=TD_ID` compiles to its single argument.
- **Variant stubs.**
  - Put `#if MICROBIT_CODAL` **inside** the exported function or around private helpers, never around the `//%` function itself. The `#else` should return a neutral value or `DEVICE_NOT_SUPPORTED`.
  - For board detection at run time, use one of:
    - `control.ramSize()`: 16384 / 32768 / 131072 on hardware and 32 MB in the simulator (`PXC\libs\core\control.ts:137-140`, `control.cpp:438-441`).
    - `control._hardwareVersion()`: `"1"` on DAL (`control.cpp:349-370`).
    - A tiny `//% bool isCodal() { return MICROBIT_CODAL; }`.
- **Real examples that build for both nRF51 and nRF52:**
  1. `GROVE\iotdap.cpp` (and the identical copy in `editors\makecode\pxt-calliope-iot\iotdap.cpp`): a Calliope extension, built for v2 and v3 in this session.
  2. [carlosperate/pxt-banana](https://github.com/carlosperate/pxt-banana) `banana.cpp`: a micro:bit extension whose `//%` functions contain `#if MICROBIT_CODAL … #else … #endif` bodies, including the `target_panic(PANIC_VARIANT_NOT_SUPPORTED)` idiom. Its README documents the `mbdal`/`mbcodal` exclusion.
  3. [microsoft/pxt-bluetooth-midi](https://github.com/microsoft/pxt-bluetooth-midi): C++ with no `#if` at all. It compiles on both because CODAL ships a microbit-dal compatibility layer (`CMB2\inc\compat\*`).
  4. In-target: `PXC\libs\core\serial.cpp:68-70,162-165,192-204` (dual implementation) and `PXC\libs\flashlog\flashlog.cpp:1-45` (CODAL body, DAL `DEVICE_NOT_SUPPORTED`).

---

## 3. Serial on DAL (mini 2) versus CODAL (mini 3)

The pxt wrapper is `PXC\libs\core\serial.cpp`. The drivers are `DAL\source\drivers\MicroBitSerial.cpp` on mini 2 and `CCORE\source\driver-models\Serial.cpp` plus `CNRF\source\NRF52Serial.cpp` on mini 3.

| Topic | mini 2 (DAL, nRF51822) | mini 3 (CODAL, nRF52833) |
|---|---|---|
| Hardware | One UART0, no DMA, 6-byte RX FIFO. One interrupt per byte (`MBED\targets\hal\TARGET_NORDIC\TARGET_MCU_NRF51822\serial_api.c:55-95`). USB CDC comes through the J-Link on pins p24/p25 (`...\TARGET_NRF51_CALLIOPE\PinNames.h:150-167`). | UARTE0 with EasyDMA and a 32-byte DMA buffer (`CNRF\inc\NRF52Serial.h:11-12`). `uBit.serial` is fixed to `NRF_UARTE0` (`CMB2\model\MicroBit.cpp:73`). UARTE1 is free (section 3.2). |
| `serial.redirect` | `serial.cpp:199-203` resolves the pins, then calls `uBit.serial.redirect(PinName,PinName)` and `baud()`. The DAL `redirect` (`MicroBitSerial.cpp:831-857`) reruns `serial_init` with the new pins, so the USB pins are disconnected. | `serial.cpp:192-197` calls `redirect(Pin&,Pin&)` and `setBaud`, and sets `is_redirected`, which also stops `dumpDmesg` (`:292-298`). CODAL `redirect` (`Serial.cpp:844-870`) sets a pull-up on RX and re-points PSEL. `NRF52Serial::configurePins` busy-waits until TX has drained (`NRF52Serial.cpp:213-224`). |
| `redirect` while another fiber reads or writes | Returns `MICROBIT_SERIAL_IN_USE` (`:833-834`). pxt `redirect` ignores the result, so the switch silently does not happen. `redirectWithStatus` returns it. | Same (`Serial.cpp:846-847`). |
| RX buffer after `redirect` | **Not created.** `redirect` attaches the RX interrupt, but `dataReceived` drops every byte until something initialises the buffer (`:95-96`): a read, `onDataReceived`, or `setRxBufferSize`. | Created by `enableInterrupt(RxInterrupt)` (`NRF52Serial.cpp:145-157`). |
| USB serial after `redirect` | Lost. The single UART now points at the module pins. `redirectToUSB` restores it (`serial.cpp:250-253`). | Lost for the same reason. The RAM mailbox (CMSIS-DAP) still works, and UARTE1 would keep USB free. |
| Default buffer sizes | 20 B RX and 20 B TX (`MICROBIT_SERIAL_DEFAULT_BUFFER_SIZE`, `DAL\inc\drivers\MicroBitSerial.h:33`). Allocated lazily with `malloc`, stored as size+1. | 20 B RX and 20 B TX (`CCORE\inc\driver-models\Serial.h:33`), plus the 32 B DMA buffer. |
| `setRxBufferSize` / `setTxBufferSize` | The parameter is `uint8_t` (`serial.cpp:263-276`). The size is stored as `size + 1` in a `uint8_t` (`MicroBitSerial.cpp:963-1003`). **255 wraps to 0**, then `malloc(0)` returns NULL, so RX is silently off. TS values ≥ 256 wrap too: 256 → size 0 → capacity 0. The old buffer is freed, which discards pending data. **Safe maximum: 254.** | Also `uint8_t`, but 255 is guarded: `if (size != 255) size++` (`Serial.cpp:995-1037`). So 254 and 255 both give 254 usable bytes. TS values ≥ 256 wrap. **Safe maximum: 254.** |
| `serial.readString()` | `n = getRxBufferSize()` is the capacity + 1, **not** the number of bytes waiting. Then `read(n, ASYNC)` (`serial.cpp:91-95`). The effect is non-blocking: it returns everything currently buffered. It costs a stack VLA of n+1 bytes and a `ManagedString` on the DAL heap (`MicroBitSerial.cpp:586-598`), then a GC copy. It returns `""` if another fiber holds the RX lock. | Same semantics (`Serial.cpp:596-603,637-676`). |
| `serial.readUntil` / `readLine` | Uses the default `SYNC_SLEEP` mode, so it blocks the fiber and **holds the RX lock while sleeping**. Other readers then get `""`, and `redirect` fails. It returns `""` at once if the lock is taken (`:715-716`). **Bug:** when the delimiter arrives while `rxBuffHead == 0` (the buffer just wrapped), `foundIndex = rxBuffHead - 1 = -1` and the line is returned empty and left in the buffer (`:769-773`). After waking it also clears the shared delimiter string (`:773`), which switches off a registered `onDataReceived`. | Same lock behaviour. The wrap bug is fixed (`Serial.cpp:777-783`). The shared delimiter is still cleared (`:783`). |
| `serial.onDataReceived(delims, h)` | Sets the one delimiter set for the whole port and registers a `DELIM_MATCH` handler (`serial.cpp:103-108`). The event fires in the ISR for **every** delimiter byte, even when the buffer is full and the byte is dropped (`MicroBitSerial.cpp:102-109`). Listeners queue while busy, up to 10 deep (`pxtbase.h:140` flag 16, `MicroBitConfig.h` depth 10). | Same (`Serial.cpp:20-60`). CODAL also raises `DATA_RECEIVED` (4) from the idle tick (`:116-123`). pxt does not expose it, but `control.onEvent(12, 4, …)` would. |
| Overflow signal | `RX_FULL` (3) per dropped byte (`:128-130`). It can be observed from TS with `control.onEvent(12 /*SERIAL*/, 3, …)`. That is only suitable as a HIL diagnostic, since it floods. | Same (`Serial.cpp:59`). |
| Writing | `send` returns `MICROBIT_SERIAL_IN_USE` while another fiber is mid-send (`:482-483`). pxt ignores this, so the text is **silently dropped**. `SYNC_SLEEP` sleeps until the TX buffer drains (`:175-198,292-299`). | Same `IN_USE` drop (`Serial.cpp:372-397`). In `SYNC_SLEEP` it waits on `TX_EMPTY` whenever the ring is full (`:83-112`). |
| `serial.writeLine` | Pads each line with spaces to a 32-byte boundary before `\r\n` (`PXC\libs\core\serial.ts:37,47-58`). Unusable for AT commands; use `writeString(x + "\r\n")` (already done in `GROVE\iot.ts:316-354`). | Same TS code. |
| Baud rates | `serial_baud` rounds down to the nearest entry in {1200, 2400, 4800, 9600, 14400, 19200, 28800, 31250, 38400, 57600, 76800, 115200, 230400, 250000, 460800, 921600, 1M} (`serial_api.c:33-49,108-122`). All `BaudRate` enum values work. | `NRF52Serial::setBaudrate` supports only 9600, 31250, 38400, 57600, 115200, 230400, 921600, 1000000. **Anything else, including the enum's 1200/2400/4800/14400/19200/28800, silently becomes 115200** (`CNRF\source\NRF52Serial.cpp:193-211`). |
| Rates that work on both boards | 9600, 31250, 38400, 57600, 115200 | |

Two more DAL points (source):

- RX handling runs in an interrupt with a 6-byte FIFO. At 115200 baud a byte arrives every 87 µs, so the FIFO buys about 0.5 ms.
- On mini 2 BLE is on by default, and SoftDevice activity blocks application interrupts. Whether that causes RX overruns at 115200 is a **HIL** question. The fallback is `AT+UART_CUR` to 57600 or 38400, which both boards support.

### 3.1 Consequences for the AT driver (both boards)

- Exactly one fiber reads from `serial`, and it never blocks in `readUntil`. Poll with `readString()` (or `readBuffer(0)`) and split lines in TS, so the DAL wrap bug and the lock never come into play.
- Exactly one fiber writes, or all writes go through one queue, because a concurrent write is dropped without an error.
- Call `setRxBufferSize(n)` with `n ≤ 254` immediately after `redirect`, before the module can send anything (DAL drops bytes until then). Clamp every size in TS.
- Choose baud rates only from {9600, 38400, 57600, 115200}.
- Treat `redirect` / `redirectToUSB` as operations that can fail while a read is pending. Stop the reader first, or use `serial.redirectWithStatus` via a shim if the status matters.

### 3.2 Second UART on mini 3 (`NRF_UARTE1`)

- `CNRF\source\peripheral_alloc.cpp:17-33` lists `NRF_UARTE1` with IRQ `UARTE1_IRQn`. `NRF52Serial(tx, rx, NRF_UARTE1)` asks for exactly that instance (`NRF52Serial.cpp:18-27`).
- The constructor panics with `DEVICE_HARDWARE_CONFIGURATION_ERROR` (090) if the instance is taken.
- Generic requests (`allocate_peripheral(PERI_MODE_UARTE)`) scan the table from the end, so they take UARTE1 first (`peripheral_alloc.cpp:57-70`). `ZSingleWireSerial` (Jacdac) does exactly that (`CNRF\source\ZSingleWireSerial.cpp:143`; used by `editors\makecode\pxt-jacdac-campus\hw.cpp:231-233`).
- **So a program that uses Jacdac and the UARTE1 driver panics 090 on whichever is constructed second.** Construct the driver lazily, and treat "Jacdac present" as a reason to fall back to `redirect`.
- The driver keeps the `codal::Serial` semantics described above: `uint8_t` buffers (≤ 254) and the baud-rate list.
- A C++ helper can drain the ring into a larger buffer inside the ISR or idle callback, which avoids the 254-byte limit on mini 3.

---

## 4. RAM budget

### 4.1 Calliope mini 2 (DAL, 32 KB, BLE on by default)

RAM layout from the linker map of a pxt DAL build (`TMP\v2local\built\dockeryt\build\calliope-mini-classic-gcc\source\pxt-microbit-app.map`: local toolchain gcc 7.3.1, `grove` included; the cloud build's `.bss` may differ by a few bytes). (built)

| Region | Range | Size |
|---|---|---|
| SoftDevice S110 | `0x20000000–0x20002000` | 8 KB (the linker RAM origin is `0x20002000`, `TGT\ld\NRF51822_32K.ld:5-6`) |
| of which reused as heap 1 while BLE is on | `0x20001F00–0x20002000` | **256 B**: GATT table start `0x20001900` + `gatt_table_size 0x600` (`PXC\libs\core\pxt.json:130`) up to `MICROBIT_SD_LIMIT` (`DAL\inc\core\MicroBitConfig.h:51-66`; created in `MB\source\MicroBit.cpp:216-221`) |
| `.data` | `0x20002000–0x2000222C` | 556 B |
| `.bss` | `0x20002230–0x20002AA4` | 2,164 B (the `uBit` object alone is 868 B) |
| **heap 0** | `__end__ 0x20002AA8` → `MICROBIT_HEAP_END = 0x20008000 − stack_size` | **about 20,570 B** (`MicroBitHeapAllocator.cpp:282-296`, `MicroBitConfig.h:74-80`, `stack_size 1280` from `PXC\libs\core\pxt.json:129`) |
| main stack | `0x20007B00–0x20008000` | 1,280 B |

Everything allocated at run time comes out of heap 0: DAL driver objects (the accelerometer and compass are `new`-ed in the `MicroBit` constructor, `MB\source\MicroBit.cpp:66-105`), BLE service objects, fiber stack copies (each fiber keeps a heap buffer the size of its stack depth, `DAL\source\core\MicroBitFiber.cpp:814-845`), serial buffers, `ManagedString` temporaries and all pxt GC blocks. `panic_on_heap_full: 0` (`PXC\libs\core\pxt.json:131`) means `malloc` returns NULL instead of panicking with 020.

How the pxt GC gets memory on DAL:

- `initMicrobitGC` pre-allocates heap 1 minus 1 KB as one GC block, but **only if heap 1 is larger than 1,028 B** (`PXC\libs\core\codal.cpp:58-62`). With BLE on, heap 1 is 256 B, so nothing is pre-allocated.
- The GC then grows by `xmalloc(GC_BLOCK_SIZE)`, which is **256 B blocks**, 248 B usable after the 8 B header (`pxtcore.h:25`, `BASE\gc.cpp:432-478`).
- An allocation first searches the free runs, then collects, then adds one 256 B block, and panics with **021 (`PANIC_GC_OOM`)** if it still does not fit (`BASE\gc.cpp:733-807`). Blocks are separate objects with headers, so free runs never merge across blocks.
- **This means no single GC object can be larger than about 248 B on a mini 2 with BLE on.** (source; to be confirmed on hardware, section 9, probe P2)
- With BLE off, heap 1 is `0x20000008–0x20002000` (8,184 B), which gives a pre-allocated 7,160 B GC block, plus the whole SoftDevice RAM. BLE is off when the program uses `funk`/`radio` (`PXC\libs\funk\pxt.json`) or when a package sets `microbit-dal.bluetooth.enabled: 0`.

What pxt objects cost (32-bit, `utf8: false` in `PXC\pxtarget.json:81`) (source):

| Object | Size | Note |
|---|---|---|
| string (not a literal) | `align4(4 vtable + 2 length + L + 1 NUL)` | `BASE\pxtbase.h:714-720`. Literals live in flash and cost no RAM. `a + b` allocates a new string of full length (there are no ropes without `PXT_UTF8`), so the peak is old + new. |
| largest string on mini 2 with BLE on | **about 241 characters** | from the 248 B limit |
| largest string on mini 3 | about 10,990 characters | `GC_MAX_ALLOC_SIZE 11000`. Above that the result is panic 022. |
| small integer | 0 B | tagged (31-bit) |
| other number | 12 B | `BoxedNumber` (`pxtbase.h:708-712`) |
| array | 12 B header + data block `4 + 4·capacity` | `pxtbase.h:536-541,594-596` |
| array capacity growth | 4 → 8 → 16 → 32 → 64 → ×5/3 | `BASE\pxt.cpp:106-117` |
| array with 33 or more elements | needs a 260 B block | **impossible on mini 2 with BLE on** |
| `Buffer` | `align4(8 + n)` | `pxtbase.h:777-782` |
| class instance | `4 + 4·fields` | |
| `readString()` on a full 254 B buffer | a 262 B GC string, plus a 255 B DAL `ManagedString` and a VLA of about 256 B on the stack, all at the same time | This alone exceeds the 248 B limit. |

Rules of thumb for mini 2 (to be confirmed by HIL):

- Keep every string, array and buffer at or below about 200 B.
- Keep the RX ring at or below about 128 B, or never read the whole ring into one string.
- Parse JSON as a stream.
- Avoid arrays of more than 32 elements. Parallel small arrays or linked records work.

### 4.2 Calliope mini 3 (CODAL, 128 KB) (built)

Layout from `TMP\v3local\built\dockercodal\build\MICROBIT.map` (cloud and local builds are byte-identical outside the per-build C++):

| Region | Range | Size |
|---|---|---|
| SoftDevice S113 + NOINIT | `0x20000000–0x20002040` | about 8 KB |
| `.data` | `0x20002040–0x20002370` | 816 B |
| `.bss` | `0x20002400–0x20004668` | 8,808 B (includes the 336 B `dapAblage` and 176 B of alignment fill) |
| heap | `0x20004668` → `0x20020000 − 2048` | **about 110,500 B** (`CCORE\source\core\CodalHeapAllocator.cpp:298-301`, `CMB2\target.json:15-17`) |

- There is only one CODAL heap, so `device_heap_size(1) = 0` and nothing is pre-allocated.
- The GC grows in 16 KB blocks. The largest single object is 11,000 B (panic 022 above that).
- RAM is not the constraint on mini 3.

---

## 5. Interface chips and the RAM mailbox

- **mini 3: DAPLink, CMSIS-DAP, VID `0x0D28` / PID `0x0204`** (`PXC\editor\extension.tsx:29-39`). CMSIS-DAP allows AHB memory access while the core runs, which is what `iotdap` and the Blocks and Jacdac mailboxes use.
- **mini 2: SEGGER J-Link OB, VID `0x1366`**. The PIDs are `0x1015` ("Mini 2.0") and `0x1025` ("Mini 2.1") (`PXC\editor\extension.tsx:40-46`, `PXC\pxtarget.json:184-189`). This confirms the chip.
  - The J-Link speaks SEGGER's own protocol, not CMSIS-DAP.
  - The Campus widget uses only its "MSD image programming" subset for flashing, and Web Serial on the J-Link's CDC port for serial (`C:\GIT\calliope-dev\lib\mini-connection-widget\src\segger-jlink.ts:1-40`, `connection-errors.ts:170-189`, `mini2-serial.ts`).
- **mini 1: DAPLink on a KL26Z** (comment in `MB\source\MicroBit.cpp:110`). It is not in scope.
- **A RAM mailbox over the debug port on mini 2 is not realistic.** In theory, raw SWD over the J-Link protocol could read RAM, but only by implementing SWD DP/AP transactions on top of SEGGER's low-level commands in the browser. Nothing in the Campus stack does that, older J-Link OB firmware already lacks even the MSD-image command (`segger-jlink.ts:287`), and on mini 2 the mailbox would also compete for the scarce RAM.
- **The only USB path on mini 2 is CDC serial, which is the same UART as the WiFi module.** So mini 2 has no USB path to the Campus in WiFi mode, and BLE is the only fallback (which in turn keeps the 248 B allocation limit, section 4.1).

---

## 6. Building locally for HIL: experiments

### 6.1 Setup (as specified)

```bash
mkdir -p C:/Users/ms/AppData/Local/Temp/pxtvariants/node_modules
cd C:/Users/ms/AppData/Local/Temp/pxtvariants
cmd //c "mklink /J node_modules\pxt-calliope C:\GIT\calliope-dev\editors\makecode\pxt-calliope"
cmd //c "mklink /J node_modules\pxt-core C:\GIT\calliope-dev\editors\makecode\pxt-calliope\node_modules\pxt-core"
cmd //c "mklink /J node_modules\pxt-common-packages C:\GIT\calliope-dev\editors\makecode\pxt-calliope\node_modules\pxt-common-packages"
echo '{ "targetdir": "pxt-calliope" }' > node_modules/pxtcli.json
```

Each project is a subdirectory with its own `pxt.json`. The global `pxt` launcher walks up the tree to find `node_modules/pxtcli.json`, so one `node_modules` serves every project. For example, `v2grove/pxt.json`:

```json
{ "name": "v2grove", "dependencies": { "core": "*", "v2": "*", "grove": "file:grove" }, "files": ["main.ts"] }
```

`grove` is a junction inside the project (`cmd //c "mklink /J v2grove\grove C:\GIT\calliope-dev\editors\makecode\pxt-grove"`). `file:` dependencies are read in place, and nothing was written into `pxt-grove`. Then run `pxt install` (about 1.7 s) followed by `pxt build`.

### 6.2 Results

All times are wall clock on this machine.

| Project | Dependencies | C++ source | Build path | Time | Flash result (`built/binary.asm:5`) |
|---|---|---|---|---|---|
| `v2plain` | core, v2 | none | target hexcache | **3.4 s**, offline | 223,812 B, 92.2 % of 237.0 KB, **18,876 free** |
| `v1plain` | core, v1 | none | hexcache (`minidalusb`) | about 3 s | same |
| `v3plain` | core, v3 | none | hexcache (`minicodal`) | about 3 s | 290,372 B, 61.6 % of 460.0 KB, 180,668 free |
| `coreonly` | core | none | hexcache (no variant, 16 KB image) | about 3 s | same as v2, but initial SP `0x20004000` |
| `v2grove` | core, v2, grove | `iotdap.cpp` | **cloud**, 12 polls | **98.5 s** | 224,300 B, 18,388 free |
| `v3grove` | core, v3, grove | `iotdap.cpp` | `~/.pxt/cache` hit (an earlier build today used the same SHA) | 2.2 s | 294,956 B, 176,084 free |
| `v2nonce` | + a one-line `nonce.cpp` (forces a new SHA) | yes | cloud, 15 polls, run in parallel with `v3nonce` | **121.5 s** | 224,300 B |
| `v3nonce` | the same for v3 | yes | cloud, 15 polls | **122.5 s** | 294,956 B |
| `v2nonce` again | TS-only change | yes | `~/.pxt/cache` hit | 5.8 s | – |
| `v2grovefull` | core, v2, grove; a `main.ts` using `setupWifi`, `uebertragung`, `verbindeDashboard`, `sende`, `sendeText`, `beiWert`, `beiText`, `lese` | yes | cache | 6 s | **error: `program too big by 3224 bytes!`** |
| `v3grovefull` | the same program for v3 | yes | cache | 3 s | generated code 25,752 B (22,540 user, 1,168 helpers, 1,920 literals); 154,472 free |

Local builds (`pxt build --localbuild`, docker image `pext/yotta:update-yotta3`, 590 MB, pulled in 104 s):

| Project | Result | Time |
|---|---|---|
| `v3local` (grove) | OK. It clones codal-core `448c923`, codal-nrf52 `1fbb724`, the nrf5sdk and codal-microbit-v2 `e0e5266` from GitHub and uses gcc 7.3.1 inside docker. The hex is byte-identical to the cloud hex in the MBR, SoftDevice and bootloader regions, and the sizes are identical. | **675 s** cold, **250 s** incremental (one new `.cpp`: 1 object plus the link; most of the time is the Windows→docker bind mount) |
| `v2local` via `pxt build --localbuild` | **Fails after 7 s** with `ENOENT …/pxt-microbit-app-combined.hex`. On Windows, `nodeutil.spawnAsync` uses `shell: true` (`CORE\nodeutil.js:57-58`), so `cmd.exe` splits `docker run … /bin/bash -c node prepYotta.js; yotta target …` (`CORE\buildengine.js:342-346`). Bash runs a bare `node`, exits 0, yotta never runs, and the build cache is still marked done. | 7 s |
| `v2local` by hand: `MSYS_NO_PATHCONV=1 docker run --rm -v "C:\…\v2local\built\dockeryt:/src" -w /src --user 0 pext/yotta:update-yotta3 /bin/bash -c "node prepYotta.js; yotta target calliope-mini-classic-gcc@https://github.com/calliope-mini/target-calliope-mini-classic-gcc#open_link && yotta update && yotta build"`, then `pxt build --localbuild` (5 s, "Skipping C++ build") | OK. All yotta dependencies come straight from GitHub; the dead yotta registry is not needed. **The runtime is 5,120 B larger than the cloud build** (229,420 B, 13,268 free), and the hex carries the v1.2.7 bootloader. | **395 s** cold |

### 6.3 Answers

- **Does a v2-only project build locally?** Yes, fully offline, in about 3 s, from `PXC\built\hexcache`, as long as no package adds C++ or yotta config. Output: `built/binary.hex` (about 650 KB of text), `built/binary.asm`, `built/yotta.json`, `built/cpp.json`.
- **Does a project with a C++ extension build for v2 and v3?** Yes, through the cloud compile service. It works for both boards (`serviceId` `calliope` for DAL, `mbcodal2` for CODAL).
  - Locally, v3 works with `--localbuild`. v2 works only with the hand-run docker command, and gives a wrong flash picture.
  - A fully offline C++ build needs Docker Hub (for the image) and GitHub (for the libraries) once. `PXT_NODOCKER=1` with a host toolchain was not tried.
- **Build time.** Bundled packages only: about 3 s. First build with a new C++ SHA: about 100–120 s through the cloud (the pxt client gives up after 300 s). Later builds with the same C++: 2–6 s, since only TS changed. The C++ SHA does not depend on TS, so TS-only iteration stays fast even with C++ in the extension.
- **Network.** Needed for every new C++/config SHA (cloud), or once for docker and GitHub (local). Not needed for TS-only programs.
- **Universal hex?** No. One hex per variant, as section 1.2 explains.

### 6.4 What is in the hexes (built)

| Region | v2 (DAL, nRF51) | v3 (CODAL, nRF52) |
|---|---|---|
| MBR / SoftDevice | S110 8.0.0 at `0x0000–0x07C0` and `0x1000–0x16918` | MBR at `0x0000–0x0B00`, S113 at `0x1000–0x1B400` |
| Runtime | `0x18000–0x35980` (121,216 B, hexcache) | `0x1C000–0x45EE0` (171,744 B) |
| User code | appended after the runtime, 1 KB aligned | appended after the runtime, 4 KB aligned |
| Bootloader | `0x3C000–0x3F944`, settings page `0x3FC00`, UICR `0x10001014` | `0x77000–0x7D2D0`, settings `0x7E000`, UICR `0x10001014–0x1000101C` |
| Source for re-import | 0x0E records after the EOF record | same |

The scripts used are `TMP\hexinfo.js` (record types and segments), `TMP\hexcmp.js` (byte comparison of an address range) and `TMP\ramsyms.js` (initial SP and reset-handler literals).

---

## 7. Other constraints

- **Flash on mini 2.**
  - `flashUsableEnd` is `0x3B400` = 242,688 B (`PXC\pxtarget.json:76-78`). The 3 KB between that and the bootloader at `0x3C000` stays reserved.
  - With the cloud runtime (18,388 free plus 4,140 already used), user code has **about 22.5 KB (22,528 B)** for the user program, the core TS actually used and the extension together.
  - The limit is enforced when patching the hex (`CORE\pxtcompiler.js:15582-15586,16220-16226`). The error is `program too big by N bytes`.
  - With a local docker DAL runtime, about 5 KB less is available.
  - mini 3: about 180 KB (`flashUsableEnd 471040`, `PXC\pxtarget.json:220-222`).
- **`targetVersions`.**
  - `"target": "7.0.3"` is compared against the running target (8.2.3). Only a **higher major version** is refused, with "requires target version" (`CORE\pxtlib.js:16348-16353`).
  - The main project's target version also decides which upgrade patches in `pxtarget.json` `compile.patches` apply to its sources. For example, `"0.0.0 - 7.0.0"` renames the package `radio` to `funk` (`PXC\pxtarget.json:174-181`).
  - Keeping 7.0.3 (as `pxt-grove` does) is fine.
- **`supportedTargets: ["calliopemini"]`.** This only affects discovery: the editor's GitHub repo list and search filter on it (`CORE\pxtlib.js:11241-11242`). It has no effect on compiling.
- **Blocks per board.**
  - MakeCode shows an extension's blocks for every board. There is no per-variant block filter for extensions.
  - The target itself shows board-specific blocks by loading `core-mini-dal` or `core-mini-codal` through `v1`/`v2`/`v3`, which an extension cannot do.
  - The simulator shows the mini 3 board only if the project depends on `v3` (`PXC\sim\dalboard.ts:128-139`).
  - Board-specific features therefore need run-time checks and block text that does not promise them on mini 2.
- **Serial and BLE interplay.** BLE on (the default for v2) costs RAM (section 4.1) and possibly UART timing (section 3). Turning BLE off in the extension's yotta config would also turn it off on mini 3 (compat mapping), and it changes the C++ SHA, so every mini 2 build goes to the cloud.
- **Static-hosted editor.** Extensions with C++ need `makecode.com`'s compile API (`PXC\pxtarget.json` `cloud.apiRoot`) from the static-hosted `makecode.calliope.cc`, including for mini 2 as soon as the extension has C++. Whether that works from the static host was not checked here.

---

## 8. What this means for our extension

1. **Flash is the first design constraint on mini 2, ahead of RAM.**
   - The current `pxt-grove#iot` IoT code does not fit next to a small user program (3,224 B too large).
   - Budget the whole extension for mini 2 at roughly 12–15 KB of generated code, so that about 7–10 KB remain for the child's program.
   - Keep long German literals and help texts out of code paths, share helpers instead of duplicating per-feed logic, and keep block count and variety small.
   - Add a size gate: build a representative `v2` test program on every change and parse `; total bytes: … free` from `built/binary.asm`. This is fast and offline while the extension is TS-only.
2. **Keep the mini 2 build free of C++.** There are two options.
   - **(a) Split into two packages.** A TS-only `iot` core plus a small mini-3-only companion (for example `iot-native`) holding `iotdap.cpp` and the UARTE1 driver. The companion registers itself with the core from its top-level TS. Campus writes the program's `pxt.json` and knows the board, so it adds the companion only to `v3` programs. The companion may even carry `disablesVariants: ["minidal","minidalusb"]`, because it never appears in a v2 program.
     - Mini 2 programs then keep the hexcache (offline, about 3 s, webdfu bootloader).
     - Mini 3 programs get the cloud build they would get anyway.
     - Plain MakeCode users on mini 3 without the companion fall back to `redirect` without the mailbox.
   - **(b) One package with C++ guarded by `#if MICROBIT_CODAL`**, as `iotdap.cpp` does today. This is simpler, but every mini 2 program needs a cloud compile (first time about 2 min for each distinct C++ configuration), depends on `makecode.com` from the static editor, and ships the 2017 stock bootloader to mini 2 (section 1.3). If (b) is chosen, the bootloader question has to go to whoever owns the mini 2 DFU path.
3. **UART ownership rules** (both boards; section 3.1):
   - One reader fiber that polls `readString()`, with line splitting in TS. No `readUntil` or `readLine`.
   - One writer. Use `writeString` + `"\r\n"`, never `writeLine`.
   - Call `setRxBufferSize` with a value ≤ 254 (clamped in TS) immediately after `redirect`, before the module is woken or reset.
   - Baud rates only from {9600, 38400, 57600, 115200}. The `AT+UART_CUR` fallback must stay inside that set.
   - No `redirect`/`redirectToUSB` while a read is pending.
4. **RAM on mini 2** (assuming HIL confirms section 4.1):
   - No single string, array or buffer above about 200 B while BLE is on. That includes `readString()` results: use an RX buffer of at most about 128 B and drain it often, or read with `readBuffer(n)` in bounded chunks.
   - Parse JSON as a stream.
   - Keep handler tables as small parallel arrays (at most 32 entries each) or linked records.
   - Count fibers (each costs its stack depth on the heap) and avoid `control.inBackground` per request.
   - If a bigger limit is needed, BLE off gives about 7 KB of contiguous GC memory. The price is no BLE on either board (compat mapping) and cloud builds on mini 2. Decide explicitly.
5. **mini 3.**
   - UARTE1 is viable. Construct it lazily, and detect and avoid Jacdac.
   - Keep the `codal::Serial` limits in mind (254 B ring, 32 B DMA). Drain the ring in C++ into a larger ring if long URC bursts must survive.
   - The RAM mailbox stays as it is. Its C++ is correct for both variants.
6. **The mini 2 USB path in WiFi mode does not exist.** In WiFi mode on mini 2, logs and traces need a different channel: BLE, a debug build that switches back with `redirectToUSB` between phases, or the WiFi module itself. The HIL `trace` step on mini 2 must work around this.
7. **HIL builds.**
   - Keep using per-board test projects: `hil.py` `--variant v2|v3` already generates `core` + `v2`/`v3`. Never flash a build made in the extension directory (it is a 16 KB image).
   - The first build after a C++ change takes up to about 2 min (cloud); the 900 s timeout in `hil.py` is enough.
   - For fast C++ iteration on mini 3 on Windows, the cloud (about 2 min) beats local docker (about 4–11 min). A WSL-native codal build would probably be faster; it was not measured.
   - Use the cloud for mini 2 hexes: the local docker runtime is 5 KB larger and misrepresents the flash budget.
   - `hil.py`'s drive detection looks for `DETAILS.TXT`, which is DAPLink-specific. Check whether the mini 2 J-Link drive (`MINI`) has it before relying on it for mini 2 (not verified).

---

## 9. Open questions for HIL

| # | Question | Probe |
|---|---|---|
| P1 | How much heap is really free on mini 2 after boot, with BLE on and with BLE off? | Allocate 200 B `Buffer`s held in a linked list (not an array, see P2) until the device panics. Before each allocation, print the count and `control.gcStats()` (`totalBytes`, `lastFreeBytes`, `numBlocks`, `lastMaxBlockBytes`; `BASE\gcstats.ts`) to the display or the serial port. Run once with a `funk` dependency (BLE off) and once without. |
| P2 | Is the largest object on mini 2 with BLE on really about 248 B? | `Buffer.create(240)`, `(260)`, `(1000)`; a string built to 241 and to 242 characters; an array pushed to 32 and to 33 elements. Expect 021 above the limit with BLE on, and success with BLE off. |
| P3 | RX overruns on mini 2 at 115200 baud with BLE advertising | Stream a long, known pattern from the ESP (for example `AT+GMR` repeated, or a 2 KB HTTP body), count `control.onEvent(12, 3)` (RX_FULL) and check the pattern. Repeat at 57600. |
| P4 | Whether DAL drops bytes between `redirect` and the first read | Send a banner from the module right after `redirect`, with and without an immediate `setRxBufferSize`. |
| P5 | UARTE1 on mini 3 | `NRF52Serial(tx, rx, NRF_UARTE1)` on the Grove A1 pins at 115200 against the ESP32-C3, while USB serial keeps logging. Repeat in a program that uses Jacdac, to confirm the 090 panic (or its absence). |
| P6 | Does a cloud-built mini 2 hex (stock bootloader) still flash and run through the J-Link MSD, and what does it do to later BLE/webdfu use? | Flash `v2grove`'s hex, then run the Campus mini 2 connection flow. |

---

## 10. mini 2 bootloader with C++

Added on 2026-09-29, after the lead decided the WiFi AT engine will be C++ on both boards. That means every mini 2 IoT program is compiled in the cloud.

The workspace is again `TMP` (`C:\Users\ms\AppData\Local\Temp\pxtvariants`). No repo was changed, and no hardware was touched. The yardstick for the "right" bootloader is the stack reference `firmware\bootloaders\v1-bootloader-src\calliope_v1v2_bootloader_webdfu.hex`:

- It is `v1.1.2-calliope-webdfu`, sha256 `31886651…` (`firmware\BUILD-PROVENANCE.md:13,39`).
- It is byte-identical, including UICR, to `BLE_BOOTLOADER_RESERVED.hex` on target `open_link` `e3e80d6` (v1.2.7).
- It is what the shipped `blocks-dal.hex` and `calliope-v1v2.hex` carry (checked: 0 diff in `0x3C000–0x40000`).

Reference values for comparing a hex:

| Region | Reference (v1.1.2 webdfu) | 2017 stock (target tags ≤ v1.2.4) | v1.1.1 webdfu (`fb6eeeb`) |
|---|---|---|---|
| Contiguous code from `0x3C000` | 14,684 B, md5 `7ee2550f21b496e4f9ba28d22acb5f1d` | 14,452 B, md5 `7be5de96ac725475430408dac532c6b1` | 14,660 B, md5 `09e0e27f0fd701f7d238ca8e7300a344` |
| Settings page from `0x3FC00` | 1,024 B, md5 `99fd6b518269b33c907b70b6db1a8e09` (bank_0 = VALID_APP) | 32 B, md5 `57793fee43f5db9626f127ea9ba9c664` | 1,024 B, md5 `0f343b0931126a20f133d67c2b018a3b` |
| UICR `0x10001014` | `0x0003C000` | `0x0003C000` | `0x0003C000` |

### 10.1 Root cause

The failing build in 10.1.2 printed the service's own yotta log. It proves the cloud builds against target **tag `v1.2.4`**, which holds the 2017 bootloader, and that it honours yotta dependencies declared by an extension.

#### 10.1.1 The yotta target is set on the server

- pxt's compile request carries only `config` (= `serviceId`), `tag` (= `gittag`), the generated files and the yotta `dependencies` (`CORE\pxtlib.js:7640-7652`). `yottaTarget`, `yottaCorePackage`, `buildEngine` and `dockerImage` are **not sent**. They are used only by local builds (`CORE\buildengine.js:16-25`).
- The service looks up a server-side record by `serviceId` in Microsoft's deployment config. pxt's local emulation of the service shows its fields: `repourl`, `binary`, `target`, `image`, `clone`, `buildcmd` (`CORE\buildengine.js`, `runDockerCompileAsync`: it reads `../../../pxt-deployment-config/production/config.json` and uses `compileServiceConfig.target`).
- That repo is private (`api.github.com/repos/microsoft/pxt-deployment-config` → 404).
- `gittag` only replaces the `#ref` of `repourl`, i.e. it picks the `calliope-mini/microbit` version.
- **So it is not an allow-list and not a ref format the service rejects. The target pin lives in Microsoft's server config, and no field in pxt-calliope can override it.** Changing `yottaTarget` to `#open_link` (the `static-hosting` branch, and also the hosted `/alpha/` editor) has no effect on cloud builds.

#### 10.1.2 Evidence from a deliberately failing cloud build

Project `TMP\v2depprobe` is `core` + `v2` with `"yotta": {"dependencies": {"calliope-probe-missing": "calliope-edu/pxt-calliope-probe-does-not-exist#v0.0.1"}}`. It failed after 54 s, and pxt printed the service log (`TMP\v2depprobe\build.log:103-133`):

```
info: download calliope-mini-classic-gcc@v1.2.4 from GitHub calliope-mini/target-calliope-mini-classic-gcc
info: update outdated: calliope-mini-classic-gcc@1.2.0 -> calliope-mini-classic-gcc@v1.2.4 from GitHub ...
info: download microbit@v2.2.0-rc6-calliope.rc5 from GitHub calliope-mini/microbit
info: get versions for calliope-probe-missing
error: could not locate github component "calliope-edu/pxt-calliope-probe-does-not-exist" ...
```

The published Microsoft-hosted editor pins exactly this target in its own `pxtarget.json`:

| Editor | Target / pxt version | `yottaTarget` | `codalTarget.branch` |
|---|---|---|---|
| `makecode.calliope.cc` (Campus preset `default`) | 8.1.15 / pxt 13.1.8 | `…#v1.2.4` | `v0.3.5-calliope-2` |
| `makecode.calliope.cc/alpha/` (Campus preset `open`) | 8.2.3 | `…#open_link` (not sent) | `v0.3.5-calliope-3-open-link-1` |

(Read from their `target.js`, `cdn.makecode.com/blob/b0bc79e7…/target.js` and `…/2627e680…/target.js`.)

The target repo's newest semver tag is `v1.2.4` (`68e6752`, 2022-04-01). Every tag holds the 2017 bootloader. The webdfu commits (`fb6eeeb`, `39de4e2` on `master`, `e3e80d6` on `open_link`, 2026-05/06) are **untagged** (`git ls-remote --tags`). The log above cannot tell a hard pin (`#v1.2.4`) from "newest tag". A locally pinned `#v1.2.4` produces the same log lines.

#### 10.1.3 Where the webdfu hexcache images came from

- `PXC\built\hexcache` is not in git (`built/` is ignored). `pxt buildtarget` / `staticpkg` fill it from whatever `getHexInfoAsync` returns, and never overwrite an existing SHA (`CORE\cli.js` near line 2330, "native image already in offline cache").
- The cache key does not include the yotta target, so a stale image survives any target change.
- Classifying all 34 DAL entries by bootloader: the **5 images from 2026-06-03** (core + `v1`/`v2`/core-only, 16 KB and 32 KB) carry `v1.1.1-calliope-webdfu` (`fb6eeeb`, exact including settings). They must have come from a local build of the `#open_link` target at that commit.
- **The other 29** (2026-06-01 and 2026-08-13, e.g. the images for `funk`/`radio` and `bluetooth`) came from the cloud and carry the **2017 stock** bootloader.
- Checked: `v2funk` (`core` + `v2` + `funk`) and `v2bluetooth` build from the hexcache in about 1 s and carry the stock bootloader.
- **So even TS-only mini 2 programs that use radio or Bluetooth get the stock bootloader today.** Only the plain core images have webdfu, and that is the older v1.1.1, not the reference v1.1.2.
- The CI deploy (`.github/workflows/deploy-cloudflare-pages.yml:40-60`) starts from an empty or cached hexcache and uses the cloud, so a fresh CI hexcache carries the stock bootloader everywhere.
- On the hosted editors (Campus default), the whole hexcache is Microsoft CI output from the same cloud. So **every** MakeCode mini 1/2 hex there most likely carries the stock bootloader. This is inferred from the pin and the cloud log. Confirm it with one browser download plus the diff in 10.4.

### 10.2 mini 3

For CODAL the target URL and branch travel inside the generated `codal.json`, so the cloud honours them. Measured from `0x77000` over the contiguous extent, and UICR `0x10001014`:

| Hex | Extent | md5 | UICR |
|---|---|---|---|
| `v3plain` (hexcache), `v3nonce` / `v3grove` (cloud, C++), `v3local` (docker) | 25,296 B | `21517b8515b75786c8cc1f7a5205ff76` (DIR2) | `0x00077000`, `0x0007E000` |
| scratch-gui `open-link-v2:static/microbit/blocks.hex` | 25,296 B | `21517b85…` (DIR2) | same |
| scratch-gui `tested-bootloader:…/blocks.hex` | 25,580 B | `b6b60be32a3f89b89bfb7974e7c6f10d` | same |

Settings `0x7E000–0x80000` are identical between cloud and hexcache.

**For the `static-hosting` target (codal `open-link-2`), cloud-built v3 hexes carry exactly the DIR2 bootloader of the `open-link-v2` line.** (built)

The hosted editors differ, inferred from their `codalTarget` and the `lib/bootloader.o` blob in `CMB2`:

| Hosted editor | codal ref | `bootloader.o` blob | Matches the Campus preset? |
|---|---|---|---|
| default | `v0.3.5-calliope-2` | `b4b8a09` = the **tested** bootloader (`b6b60be3`), the same as the `v0.3.5-calliope-3` and `tested-bootloader` refs | Yes: preset `default` uses tested-bootloader Blocks and Python. |
| `/alpha/` | `open-link-1` | `36dc2f4` | No: preset `open` uses DIR2 (`open-link-2`, blob `3a5c9f2`). `/alpha/` lags `static-hosting` commit `96ba9676` ("Update codalTarget branch to v0.3.5-calliope-3-open-link-2"). |

So mini 3 is not affected by the C++ decision. The one mismatch (`/alpha/`) is a deployment lag, fixed by redeploying.

### 10.3 Fix options

| | What | Who changes what | Reach | Survives MakeCode caching? | Effort / risk |
|---|---|---|---|---|---|
| **(a)** | Make the cloud use a target with webdfu. **(a1)** Push a semver tag (`v1.2.7` on `e3e80d6`) to `calliope-mini/target-calliope-mini-classic-gcc`. **(a2)** Ask Microsoft to change the `calliope` record in `pxt-deployment-config` to that tag. Editing `pxtarget.json` `yottaTarget` does nothing. | (a1) the target repo owner; (a2) Microsoft | Every cloud DAL build of every Calliope MakeCode (hosted and static) | **No, not by itself.** CDN results are keyed by request SHA, which contains neither target nor bootloader, so every SHA built before keeps the stock bootloader. Also needs a `gittag` bump (a new `calliope-mini/microbit` tag with identical code) so every DAL SHA changes and the hexcache is rebuilt. | (a1): minutes, but it only works if the server resolves "newest tag", which 10.1.2 cannot tell apart from a hard pin; a probe build (10.4) settles it. (a2): external, timeline unknown. Both change the bootloader globally, including mini 1 and the Microsoft editor, so this needs product sign-off. The reference image is 16 KB-safe (SP `0x20003F80`). |
| **(b)** | Post-process the hex: replace `[0x3C000,0x40000)` and UICR `0x10001014` with the reference bytes. **(b1)** in pxt-calliope `editor/extension.tsx`, through the extension hook `patchCompileResultAsync` (pxt calls it before both download and deploy; `CORE\localtypings\pxteditor.d.ts:1179`, and in `built/web/main.js` "…patchCompileResultAsync(o),e)return void await pxt.commands.saveOnlyAsync(o)"). **(b2)** in Campus: every MakeCode hex passes `lib/makecode/driver.ts:133-153` (`onDownload` → `flashCalliope`, `onSave` → `downloadHexFile`). The widget already parses hexes with `nrf-intel-hex` (`hex-inspect.ts`). | (b1) the Calliope target (static deploy; hosted only after an upstream release); (b2) mini-connection-widget or Campus | (b1) all hexes of that editor build, TS-only included; not CLI/HIL. (b2) all MakeCode flashes and downloads inside Campus, whichever editor host, TS-only included; not users outside Campus. | **Yes.** It runs on the final hex every time. | Small: about 60 lines plus fixtures from `TMP`. Splice as text, not through `MemoryMap` round-trip, because `nrf-intel-hex` stops at EOF and would drop the `0x0E` source records after it, which breaks re-import. The swap must cover the full reference extent: stock is 14,452 B + 32 B, reference 14,684 B + 1,024 B (see the truncation warning in the `build-calliope-firmware` skill §4). Only for nRF51 hexes (UICR → `0x3C000`); leave universal and CODAL hexes alone. The stack's existing region swaps are offline only: the skill §4 `swap.js`, for `blocks.hex` at `0x77000`. No runtime swap exists yet. |
| **(c)** | No C++ on mini 2 | the extension | – | – | This contradicts the lead's decision and the 22.5 KB TS budget; C++ built with `-Os` is probably denser than pxt's TS code (not measured). It **does not fix the bootloader anyway**: TS-only radio/bluetooth programs and everything on the hosted editors already carry the stock bootloader (10.1.3). Not recommended. |
| **(d1)** | **A yotta dependency added by the extension** that overrides the target's bootloader merge. A tiny public module (e.g. `calliope-edu/yotta-calliope-webdfu`) holds `module.json`, the reference `BLE_BOOTLOADER_WEBDFU.hex` and `source/webdfu.cmake`. yotta includes every `*.cmake` in a module's `source/` at the end of its generated CMakeLists (yotta 0.20.5 `lib/cmakegen.py:645-662,760-780`; templates `subdir_/dummy_CMakeLists.txt`). CMake commands are global, and all `ym/*` dependencies are added before the app's `source/`, so redefining `yotta_apply_target_rules` there makes `srec_cat` merge our bootloader instead of the target's. The extension's `pxt.json` gets `"yotta": {"dependencies": {"calliope-webdfu": "calliope-edu/yotta-calliope-webdfu#v1.0.0"}}`. pxt forwards this to the cloud (`CORE\pxtlib.js:7396-7400,7640-7648`), and the service honours it (10.1.2). CODAL builds ignore `yotta.dependencies`. | the extension, plus one new small repo | Every mini 1/2 build of a program that uses `iot`, **on every host** (hosted default, `/alpha/`, static, and CLI/HIL), because the request is built in the client from the extension's `pxt.json`. Programs without `iot` are unchanged. | **Yes.** The dependency spec is part of the request SHA, and a new module tag gives a new SHA. | **Proven locally** (`TMP\dalov`): the same app built against the cloud's target `#v1.2.4` (bootloader md5 `f26a04c2…`, identical to the cloud's) with the override linked gives `0x3C000–0x40000` and UICR **byte-identical to the reference**, and the whole image byte-identical to the `#open_link` build. It adds 0 app bytes (an empty dummy lib). Risk: it relies on yotta internals and on the service keeping yotta with `ym/`-before-`source/` ordering, so check every release with 10.4. Not yet run in the cloud, because the module repo has to exist first. |
| **(d2)** | The same `.cmake` override inside `calliope-mini/microbit` (new tag `…rc6`), plus a `gittag` bump in `pxtarget.json` | the microbit repo and the Calliope target | All DAL cloud builds of the target build that carries the new `gittag` (TS-only included), but not the hosted editors until Microsoft releases it | **Yes** (`gittag` is in the SHA). The CI hexcache is rebuilt (its key hashes `pxtarget.json`). | Same mechanism as (d1), scoped to the target. The long-term clean fix for the static deploy, together with (b1). |
| **(d3)** | Bundle prebuilt, correct hexes for the known C++ combinations in the static deploy's `/hexcache/` | the Calliope target CI | Static editor only, known combinations only (the SHA depends on every C++ package) | Yes | Brittle. Also, the deployed `calliope-makecode.pages.dev` answered `/hexcache/<sha>.hex` with the SPA `index.html` for three current SHAs. That is unexplained and needs checking. |

**Recommendation.**

1. Do **(d1)** now. It is extension-owned, works on every editor host including Campus's default, is cache-safe, and is proven locally.
2. Add **(b2)** in the widget as a guard. It fixes TS-only programs too, and gives every Campus DAL flash the same bootloader as Blocks and Python.
3. Pursue (a2) with Microsoft, or (d2) + (b1) in the target, for users outside Campus. This is a product decision because it changes the bootloader globally.

### 10.4 Verifying without hardware

1. **Region diff against the reference** (scripts in `TMP`):
   - `node hexcmp.js <reference> <hex> 0x3C000 0x40000` and `… 0x10001014 0x10001018` must both report 0.
   - `node blmd5.js <hex> 0x3C000 0x3FC00` must give 14,684 B, md5 `7ee2550f…`.
   - The settings page (`blmd5.js <hex> 0x3FC00 0x40000`) must give 1,024 B, md5 `99fd6b51…`.
   - For (b), check in addition that every byte outside those two ranges is identical to the unpatched hex, and that the `0x0E` records after EOF are unchanged.
2. **Cloud check for (d1).** Build a fresh-SHA project (`nonce.cpp` trick, section 6.2) for `v2` with the extension, then run step 1 on `built/binary.hex`. Repeat for `v1` (16 KB). For `v3`, check that the hex is unchanged: 25,296 B, `21517b85…` from `0x77000`.
3. **Which target does the cloud use?** Add a deliberately missing yotta dependency. The failing build prints `download calliope-mini-classic-gcc@vX` (10.1.2). This settles (a1) after tagging, without a successful build.
4. **Host sweep.** Download one mini 2 hex each from `makecode.calliope.cc`, `/alpha/` and the static deploy in a browser, plus one Campus flash hex from the `onDownload` log, and run step 1. This confirms the inference in 10.1.3 and later the fix.
5. **HIL gate.** Make `hil.py build` run step 1 for `--variant v2`/`v1` and step 2's v3 md5 check, and fail on a mismatch. This catches a silent regression if the service changes.

The override module used for the local proof is in `TMP\dalov\dockeryt\webdfu-mod\` (`module.json`, `source/webdfu.cmake`, `BLE_BOOTLOADER_WEBDFU.hex`). It can serve as the starting point for the repo in (d1).
