# Measurement: second hardware UART (UARTE1) on the Calliope mini 3

Date: 2026-09-29 · Board: Calliope mini 3 (nRF52833, DAPLink 0258) · Module: ESP32-C3, ESP-AT 3.3.0.0 on Grove A1 (TX C17, RX C16, 115200)

## Question
Can an extension give the WiFi module its own UART instead of `serial.redirect`, so USB serial stays usable?

## Method
`tools/hil/spikes/uarte1/`: extension C++ constructs `NRF52Serial(*getPin(C17), *getPin(C16))` without an explicit
device, i.e. lets the CODAL peripheral allocator pick a free UARTE. The program reports which UARTEs are enabled
(`NRF_UARTEx->ENABLE`), exchanges AT commands over the new port, and prints everything over USB serial (`uBit.serial`,
UARTE0). Run: `python tools/hil/hil.py run spikes/uarte1/program.ts --no-ext --dep uarte1spike=file:<abs path>` then
`hil.py trace --reset`.

## Result
```
uartes enabled before: 1                      (UARTE0 = USB)
begin -> 1, uartes enabled after: 3           (UARTE0 + UARTE1)
AT -> OK
ATE0 -> OK
GMR -> AT version:3.3.0.0(3b13d04 - ESP32C3 - May  8 2024 08:21:54) | … | Bin version:v3.3.0.0(MINI-1) | OK
CWSTATE -> +CWSTATE:2,"Werkstatt-WLAN" | OK
usb still alive after AT exchange
```
All output reached the PC over USB serial while the module talked over UARTE1. The program kept running (heartbeat).

## Conclusion
On mini 3, UARTE1 is a real, free hardware UART (Nordic MDK: `UARTE_COUNT 2`, `NRF_UARTE1` at 0x40028000, IRQ 40,
EasyDMA) and CODAL hands it out. The WiFi port can use it; USB serial stays free for Campus, logs and user programs.
Mini 2 (nRF51, one UART) keeps the exclusive-`redirect` port.

Open: RX buffer is `uint8_t`-limited (254 used); a C++ drain into a larger ring is still to be built.
