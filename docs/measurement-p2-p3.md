# Measurement: WLAN client and IoT core on the Calliope mini 3

Date: 2026-10-13 · Board: Calliope mini 3 (MINI drive now F:) · Module: ESP32-C3, ESP-AT 3.3.0.0 on Grove A1 ·
Server: local PocketBase `http://192.168.1.172:8090` · Node: 103/103 tests green.

## 0. Wedged module after five idle days
The first run of the (unchanged, previously passing) C++ engine test got **no byte at all** from the module:
every command timed out, no URCs, module LED on. A flash only resets the Calliope; the module stays powered.
After unplugging USB for ~10 s everything passed again (`measurement-cpp-engine.md` result reproduced).
→ The client needs a recovery path that does not need a power cycle (see §4).

## 1. WLAN client — `tools/hil/programs/wifi-client.ts`
`hil.py run programs/wifi-client.ts --variant v3 --var DEV=-781 --start "=====WIFI=====" --end "=====END====="`

| Step | Result |
|---|---|
| connect → online | 3.4 s (5 s cold-boot rule included), RSSI −58 dBm, caps 15 |
| HTTPCPOST, `since=0` | ok, `cur=62`, 13 snapshot rows, 675-byte body, 231 ms |
| HTTPCPOST, `since=cur` | ok, `cur=64`, 0 rows |
| back-to-back → 429 | `too_fast`, `retryAfterMs=1000`; retry ok; replay of the same (boot, seq) → `dup:1` |
| raw TCP + passive receive | ok, `passivePending` ends at 0 |
| production, HTTPCPOST over HTTPS | 404 JSON body (IoT routes not deployed on `campus-api.calliope.cc`): TLS + framing OK |
| production, raw `CIPSTART "SSL"` | 404 parsed from the status line; **one 15 s timeout** in the first run, 0 timeouts in 6 tries of `programs/ssl-prod.ts` |

Answers to the open questions from the client's report:
- **HTTPCPOST on 4xx:** the error body arrives as a normal `+HTTPCPOST:<len>,<body>` frame
  (`{"error":"too_fast","ok":0,"retry_after":1}`, `{"error":"device_blocked","ok":0}`, the 404 JSON).
- **HTTPCPOST works with `CIPRECVMODE=1` set.**
- **Umlauts:** a `"Grüße 21"` literal is stored as `Gr\xfc\xdfe 21` = "Grüße 21" (U+00FC, U+00DF) — the
  Latin-1-literal handling is right end to end. The `n` label "HIL Temp" arrived.
- The real device id `2656000046` was answered with `device_blocked` (blocked on the test dashboard on
  2026-10-13 11:24, not by the test). The run used `--var DEV=-781`.

## 2. IoT core, Campus path — `tools/hil/programs/campus-core.ts`
Without a Campus tab attached. `hil.py trace --reset` captured the full run:
- hello `r:a`, `i:2656000046`, `s:…`, `h:<ref>` in order; the injected probe `IOT1:?` re-sends it.
- **11/11 local checks pass:** scope from read blocks, own value fires "all" and skips "all but me", read of own
  value, downlink line fires the handler, own value coming back ignored, value for another device fires
  nothing, clock unknown → set by `t:`/`z:`, `onSent` after lines leave, burst of 12 drained in order.
- Steady state: `zaehler`/`temperatur` every 5 s, status line with the local clock.

Open design question (for the blocks, P4): `read(feed)` without an addressee also returns values addressed
to *another* device (they are cached on purpose, readable with an explicit `to`), while handlers do not fire
for them. Via the server such rows never reach a device (snapshot and cursor filter them); via the Campus relay
they might.

## 3. Not yet tested on hardware
- Campus end to end: mailbox and serial with a real Campus tab (hello whole, burst of 12 without loss, probe
  from Campus, long downlink line, no double relay), BLE side channel, simulator panel.
- WLAN path from the core (`iotcore` → `wlanSender()` → `iotwifi.postIngest`) as one program.

## 4. Follow-ups
- Client recovery for a silent module without power cycle: guard-timed `+++` (exit transparent mode), a burst
  of filler to complete a pending `CIPSEND` prompt, then `AT`/`AT+RST`; report `no-module` to the user if all
  fails ("unplug the module").
- `iottypes.ts`: let the client tell the core whether the module shares the USB UART (redirect fallback) — on
  UARTE1 the core could keep USB serial for logs while on WLAN.

## 5. Found in review: the widget's "H" probe disabled the Campus serial downlink
The core reads USB serial by polling and lets go of it for good at the first line that is not `IOT1:`
(so a program reading serial itself loses at most one line). The connection widget writes `H\n` over USB
serial after every flash (`mini-connection-widget/src/usb.ts` `primeBlocksRuntimeProbe`). The core took that
for program input and stopped reading serial — and Campus sends its probe `IOT1:?` over serial only, so a tab
connecting after the program started would never get a hello and could not relay.
Fixed in `iotcampus.ts` (`HOST_PROBE`), with a Node test (Campus tests 19/19). To verify on hardware: write
`H\n` then `IOT1:?\n` to the device's COM port and expect a second hello.

## 6. Hardware results after the follow-ups (2026-10-13, afternoon)

**Soak, core + WLAN (`programs/wifi-core.ts`, 1 value/s, interval 1 s):** from 12:08:01 until the local
PocketBase was stopped at 12:45:31 (outside the test): **2218 values, 1..2218, none missing, none duplicated,
none out of order** (`tools/hil/soakcheck.py`). Device side: confirmed == sent, RSSI −51…−54 dBm, engine
lost=0 resets=0 busy=0. The server stop turned the rest into an outage; not evaluated (server not restarted).

**"H" probe fix on real serial:** after writing `H\n` and then `IOT1:?\r\n` to COM4, the device answered with the
full hello (r/i/s/h). Fix confirmed.

**Wedged module, reproduced and recovered (`programs/wedge-recover.ts`):**
- `PHASE=1h` leaves the module waiting for the data of an `AT+HTTPCPOST`. After that the module answers
  nothing — and it **stays deaf across a reset/reflash of the Calliope**. This is the state found in the
  morning (§0).
- `PHASE=2` (a normal `iotwifi.connect()`): online after 12.7 s **without a power cycle**, recovery rung
  `filler`, ladder 5.6 s, 801 bytes heard. The final post failed with `send` only because the server was down.

**New bug — USB serial corrupted while the module transmits on UARTE1.** The soak's USB status lines miss
characters ("cock=", "confired", "esets"). Cause (codal-core `Serial::setTxInterrupt` + `NRF52Serial`): a
SYNC_SLEEP writer with a full TX ring sleeps on `DEVICE_ID_NOTIFY / CODAL_SERIAL_EVT_TX_EMPTY`, which ALL
serial instances fire, and writes the next byte without re-checking room. Our UARTE1 firing the event wakes
the USB writer early → it overwrites an unsent byte. Affects every program's `serial.writeLine` and the
MakeCode monitor while WLAN is active. Fix in progress (C++ port); test `programs/usb-integrity.ts`.

## 7. USB serial during module TX: A/B of the DMA fix (2026-10-13, evening)

`programs/usb-integrity.ts` (nonstop checksummed USB lines while the main fiber drives the module with local
AT commands, 60 s, ~14 200 lines per run), oracle `tools/hil/usbcheck.py`:

| Build | Runs | USB lines | Notes |
|---|---|---|---|
| no extension (`usb-baseline.ts`) | 2 | intact | reference |
| `TXMODE=ring` (old path) | 2 | intact | the bug did **not** reproduce with local AT traffic; junk check 0/59 in run 1 |
| `TXMODE=dma` (fix) | 6 | 4 intact; 1 with the tail cut off; 1 not started | runs 4–6: 0 corrupt, 0 missing, module side all OK, `dmaStuck=0` |

The two DMA failures were not corruption inside lines but output that stopped. `programs/usb-wifi.ts` (the
same USB lines while the core posts one value per second over WiFi for 10 min, the soak's situation) showed
it again: 2075 intact lines, then output stopped mid-line and never came back. **The display showed the tick**:
the program ran its 10 minutes and the server confirmed every value. So the mini did not hang. The DAPLink's
USB serial bridge stopped. The same DAPLink had just failed to remount its drive after the flash. The
DAPLink hung at flash time three times this evening (always with a nonstop-writing program on the target or
just finished).

Second `usb-wifi.ts` run with `TXMODE=dma`, after a replug: **138 536 lines, none damaged inside a line**
(the soak bug was characters missing *inside* lines), 342/342 posts confirmed, `busy=0 lost=0 resets=0
dmaStuck=0`, RSSI −55. One contiguous gap of 216 lines, and exactly there the stream carries
`<DAPLink:Overflow>`, the marker DAPLink writes when its own serial buffer overflows (the 224-line gap of DMA
run 3 carries it too). `usbcheck.py` now counts these markers and does not blame the device for gaps they
explain.

**Status:** on the device side the DMA path is clean in every run (local AT traffic and real WLAN). Every
failure seen so far is the DAPLink (overflow, or its serial bridge or drive hanging). The control run
(`TXMODE=ring` under WLAN, does this test see the soak bug at all?) is still open: the DAPLink hung again
while flashing it.
