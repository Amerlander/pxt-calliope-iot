# Measurement: panic at cold boot when a UART is opened on C16/C17 early

Date: 2026-09-29 · Board: Calliope mini 3 (DAPLink 0258) · Module: ESP32-C3 on Grove A1 (C17 TX, C16 RX)

## Observation
After unplugging and re-plugging USB (cold boot), programs that open a UART on C16/C17 during startup showed a
panic on the LED matrix (read as "504"; CODAL defines 50 accelerometer, 51 compass, 52 DAPLink comms). After a
flash (warm reset by the DAPLink) the same programs always ran.

## Isolation (each row: flash = warm boot OK; then USB unplugged ≥ 10 s and re-plugged)
| Program | Module attached | Cold boot |
|---|---|---|
| minimal: core only, heart + serial heartbeat | no | **runs** |
| minimal + extension with C++ (reads UARTE ENABLE registers, opens no UART) | no | **runs** |
| UARTE1 spike: opens `NRF52Serial` on C17/C16 at ~1.5 s | yes | **panic** |
| UARTE1 spike: same | no | **panic** |
| Program 2 (`grove.setupWifi` → `serial.redirect` to C17/C16 at start) | yes | **panic** |
| UARTE1 opened only after 5 s (`coldboot-delay.ts`, DELAY=5000) | yes | **runs** (heart, then check mark) |

## Conclusion
Not a power or module problem: it happens without the module. Opening a UART on C16/C17 in the first seconds after a
cold boot panics the board; opening it after 5 s does not. Plausible (unproven) mechanism: at cold boot the interface
chip boots in parallel and CODAL talks to it (panic 52 = DAPLink comms failure) while the new UART disturbs the lines.

## Consequences
- The extension must not open the module UART until startup has settled. Threshold between 1.5 s and 5 s — bisect
  (2.5 s / 3.5 s) and look for a readiness signal instead of a fixed delay.
- Today's `grove.setupWifi` (called first thing in `beim Start`) is affected: classroom cold boots panic.
- Open: the exact mechanism (Calliope mini 3 schematic: what else is on the C16/C17 nets; CODAL fork
  `calliope-edu/codal-microbit-v2@v0.3.5-calliope-3-open-link-2`: interface/I2C startup path).
