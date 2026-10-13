# Measurement: C++ AT engine on the Calliope mini 3

Date: 2026-10-08 · Board: Calliope mini 3 (DAPLink 0258) · Module: ESP32-C3, ESP-AT 3.3.0.0 on Grove A1 (C17 TX, C16 RX)
Program: `tools/hil/programs/cpp-engine.ts`, run with
`python tools/hil/hil.py run programs/cpp-engine.ts --variant v3 --start "=====SUMMARY=====" --end "=====SUMEND====="`.

## Result (second run, after the passive-length fix)
```
begin=1 (own UART) after 4004 ms, uptime 5005          cold-boot rule: waits until 5 s uptime
portKind=1 tickDrain=1                                  UARTE1, drained on the system tick
detect flags=15 family=2 major=3 at=3.3.0.0 chip=ESP32C3 bin=v3.3.0.0(MINI-1)
CWSTATE OK · CWJAP OK · status=19 (wifi, ip, port open)
HTTPS GET  payload(51)  {"message":"API is healthy.","code":200,"data":{}}
HTTPCPOST  payload(225) {"cur":11,"n":1,"ok":1,…}
passive: pending 462 → pulled 462 bytes, complete JSON tail
active:  received 462 bytes, complete JSON tail
urcs: WIFI DISCONNECT, WIFI CONNECTED, GOT IP, CONNECT, +IPD 462/262/62, CLOSED, CONNECT, CLOSED
stats passive=0 resets=0 busy=0 stale=0 lost=0 ringStalls=0
heartbeats during run=54                                USB serial written by another fiber throughout
```

## Findings
- **Own UART works under load.** All AT traffic over UARTE1 while a second fiber wrote to USB serial every
  250 ms: no lost bytes, no stalls, no corrupted replies. Simultaneous TX on both UARTs is fine.
- **Bug found and fixed:** in passive mode the module re-announces the **remaining total** after every partial
  `AT+CIPRECVDATA` (`+IPD,462` → `+IPD,262` → `+IPD,62`). The engine added these up and ended at
  `passivePending=322` after a complete drain (first run). Fixed in `wlanat.cpp` and `wlanat.ts` (set instead of
  add); both test fakes now model the re-announcement and both suites assert it (Node 26/26, C++ 29 tests / 703
  checks with ASan + UBSan). Second run: `passive=0`.
- This also explains the unexplained `+IPD,95` after `+IPD,295` seen with the TS engine on 2026-09-29.
