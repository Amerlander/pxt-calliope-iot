# iot — Calliope mini ↔ Calliope Campus dashboard

Standalone MakeCode extension (package `iot`, namespace `iot`) that replaces the
IoT blocks living in the `amerlander/pxt-grove#iot` fork.

- With the "connect to WiFi" block: a WiFi module with ESP-AT firmware on the second hardware UART
  (tested: ESP32-C3, ESP-AT 3.3, on Grove A1). Calliope mini 3 only.
- Without it: through the open Calliope Campus tab (USB, RAM mailbox on mini 3; BLE), and in the simulator.

Status: in development. Design and plan:
`calliope-campus/nimbalyst-local/plans/iot-extension-standalone.md`.

## Layout

| Path | Content |
|---|---|
| `*.ts`, `*.cpp` | the extension (only files listed in `pxt.json` are part of the package) |
| `wlanat.h/.cpp` | AT engine in C++ (pure C++11, shared by mini 2 and mini 3) |
| `wlanport.cpp`, `wlanshims.ts` | board glue (UART, RX ring, cold-boot guard) and the TypeScript shims |
| `tools/unit/` | Node unit tests for the device-independent parts (AT parser, JSON, batching); `wlanat.ts`/`wlanport.ts` are the TS reference engine they test |
| `tools/unit/cpp/` | host tests for the C++ engine (`sh tools/unit/cpp/run.sh`, needs g++: Linux, WSL, macOS) |
| `tools/hil/` | hardware-in-the-loop: build with the pxt CLI, flash over the MINI drive, read traces, check the server |
| `docs/` | notes and measurements |
