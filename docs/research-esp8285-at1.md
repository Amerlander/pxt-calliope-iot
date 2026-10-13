# Research: Grove UART WiFi V2 (ESP8285, NonOS AT 1.x) next to ESP32-C3 (ESP-AT 3.3)

Date: 2026-09-29. Scope: facts needed for a WiFi driver in `iot` that supports two module
families behind capability detection. Nothing here was measured on the Grove V2 itself;
all hardware-side claims about it must still be confirmed with a real module (see §9).

**Evidence labels** (used throughout):

| Label | Meaning |
|---|---|
| **[V]** | Verified from a primary source: Espressif documentation or release notes, Espressif's own AT binaries (string tables scanned by us), Seeed's schematic/firmware files, the Calliope mini 3 schematic, datasheets, or our own TLS probe of `campus-api.calliope.cc`. |
| **[M]** | Measured by us on the ESP32-C3 module (hardware session 2026-09-29, see the plan `iot-extension-standalone.md` §1.1). |
| **[S]** | Secondary source (blog, forum, community page). Plausible, not checked against a primary source. |
| **[I]** | Inferred. Reasoning from the above; must be measured before relying on it. |

---

## 0. Key findings

1. **The Grove V2 most likely ships with Espressif NonOS AT 1.6.x** (probably 1.6.2, SDK 2.2.1), not 1.7.x. Two independent owners report "1.6" [S]; Espressif staff stated in 2018 that 1.6.2 is the last AT that fits 1 MB flash [S]; the V2 was released in March 2018 [V]. The firmware on Seeed's wiki is AT **0.24** for the 4 MB V1 layout and bricks a V2 if flashed as-is [V]/[S].
2. **AT 1.6.x has no passive receive.** `AT+CIPRECVMODE/CIPRECVDATA/CIPRECVLEN` appeared in AT **1.7.0** (NonOS SDK 3.0, Aug 2018) [V]. On 1.6.x only active `+IPD,<len>:<data>` exists [V: scan of Espressif's 1.6.2 1 MB binary].
3. **No module in the ESP8266 NonOS family can talk TLS to `campus-api.calliope.cc`.** The server accepts only ECDHE key exchange and sends a 4321-byte certificate chain without honouring Max Fragment Length [V: our probe]. NonOS AT has no ECDHE cipher suite and a TLS buffer of at most 4096 bytes [V]. The ESP8285 path is therefore **http only**.
4. **No `SYSSTORE`, no `CWSTATE`, no `HTTPCLIENT` in any NonOS AT** [V]. Use `_CUR` commands (RAM only) and `AT+CWJAP_CUR?` / `AT+CIPSTATUS` for status. `AT+CWJAP` (without suffix) and `AT+CWMODE` are deprecated aliases of `_DEF` and write flash; NonOS writes only when the value changes [V].
5. **Join failure ends differently:** NonOS `+CWJAP_CUR:<1-4>` then **`FAIL`**; ESP-AT `+CWJAP:<n>` then **`ERROR`** [V]. `AT+SLEEP` mode numbers are swapped between the families (NonOS 1 = light, 2 = modem; ESP-AT 1 = modem, 2 = light) [V].
6. **ESP-AT 2.x runs on the ESP8285 (1 MB)** via Espressif's `ESP8266_1MB` build config, latest ESP8266 line is **v2.3.0.0_esp8266 (2025-08)** [V]. It would bring passive receive, `SYSSTORE`, `CWSTATE`, `CWMODE=0` and a modern mbedTLS, but **not** `HTTPCLIENT/HTTPCPOST` [V]. Flashing needs a USB-serial adapter per module; not a classroom path.
7. **Power:** the Calliope mini 3 feeds the Grove VCC pin straight from an NCP114 LDO (300 mA rated, typ. 600 mA current limit) [V]. The ESP32-C3-MINI-1 draws up to **350 mA** in TX and wants a ≥ 0.5 A supply at 3.0-3.6 V [V]. On 2×AAA the rail sits below 3.0 V through two Schottky diodes [V schematic] / [I voltages]. A brownout/reset loop of the ESP at cold boot is a plausible cause of panics 050/051 [I]. `AT+CWAUTOCONN=0` removes the scan/join bursts after boot but not the RF calibration; persisting `AT+CWMODE=0` (ESP-AT only) removes RF activity at boot entirely [I].

---

## 1. Which firmware does the Grove UART WiFi V2 ship with?

### 1.1 Evidence

| Source | Statement | Label |
|---|---|---|
| Seeed wiki, spec list | "AT Firmware: esp_iot_sdk_v1.1.0", "Baud Rate: 115200", "Input voltage: 3V / 5V", "ESP8285 ... build-in 1MB flash". The spec block is inherited from the 2016 V1 page. | [V] (text), content is stale |
| Seeed wiki, "Firmware update" | Links `Grove-uart-wifi-firmware-bin.zip` and `FLASH_DOWNLOAD_TOOLS_v1.2_150512.zip`. We unpacked the zip: `boot_v1.4(b1).bin`, `user1.4096.new.6.bin` (4 MB flash map), `esp_init_data_setting.bin`, `blank.bin`. String scan: SDK `1.1.0`, `May 22 2015`, `SeeedStudio`, `compile time:`, `Jun  1 2015 15:46:19`. | [V] |
| Seeed forum, 2022-12 (user ilnovi) | After restoring the wiki image: `AT version:0.24.0.0(May 22 2015 19:20:14)` / `SDK version:1.1.0` / `SeeedStudio` / `compile time:Jun  1 2015 15:46:19`. Needed DOUT flash mode to boot at all (`csum err` otherwise). Asks for "the stock firmware (1.6 if I'm not wrong)". | [S], GMR matches our scan [V] |
| Carmine Noviello (same person), blog 2022-12 | "The module I bought through DigiKey was delivered with the ESP-AT 1.6 release". Wiki images are "release 0.24" and for the ESP8266 V1. | [S] |
| Espressif forum, staff (Her Mary), ~2018 | "With 1MB flash, you can only download the AT v1.6.2." | [S] (vendor staff, forum) |
| NonOS SDK v3.0 release notes | AT 1.7.0: "only `1024+1024 flash map` is supported by default" (i.e. ≥ 2 MB). The 1 MB "at_nano" build came back only in SDK 3.0.4 / AT 1.7.4 (2020-06). | [V] |
| Seeed wiki version table | V2.0 released "26th Mach 2018", ESP8285, 2 buttons (reset, boot). | [V] |

**Conclusion:** the stock V2 firmware is almost certainly NonOS AT **1.6.0 or 1.6.2** (the only official AT releases for 1 MB between Feb 2018 and Jun 2020) [I]. It could be a Seeed-customised build (the V1 image printed an extra `SeeedStudio` line) [I]. Modules re-flashed by users may run anything from 0.24 to ESP-AT 2.x. **Action:** read `AT+GMR` from our unit before finalising the ESP8285 branch.

### 1.2 Expected `AT+GMR` output per candidate

All lines end with `\r\n`; a blank line precedes `OK`.

| Firmware | `AT+GMR` response | Label |
|---|---|---|
| Seeed wiki image (V1) | `AT version:0.24.0.0(May 22 2015 19:20:14)` / `SDK version:1.1.0` / `SeeedStudio` / `compile time:Jun  1 2015 15:46:19` | [S] + [V] strings |
| NonOS AT 1.4.0 (SDK 2.1.0) | `AT version:1.4.0.0(May  5 2017 16:10:59)` / `SDK version:2.1.0(116b762)` / `compile time:...` (no `Bin version` line) | [V] strings in the official bin, exact line assembly [I] |
| NonOS AT 1.6.0 (SDK 2.2.0) | `AT version:1.6.0.0(Feb  3 2018 12:00:06)` / `SDK version:2.2.0(f28eaf2)` / `compile time:...` / `Bin version(Wroom 02):1.6.0` | same |
| **NonOS AT 1.6.2 (SDK 2.2.1)** | `AT version:1.6.2.0(Apr 13 2018 11:10:59)` / `SDK version:2.2.1(6ab97e9)` / `compile time:...` / `Bin version(Wroom 02):1.6.2` | same |
| NonOS AT 1.7.4 | `AT version:1.7.4.0(May 11 2020 19:13:04)` / `SDK version:3.0.4(9532ceb)` / `compile time:May 27 2020 10:12:17` / `Bin version(Wroom 02):1.7.4` | [S] (sigmdel, real module) |
| NonOS AT 1.7.6 (last) | `AT version:1.7.6.0(Jan 24 2022 08:56:02)` / `SDK version:3.0.6-dev(072755c)` / `compile time:Jun 17 2024 07:37:49` / `Bin version(Wroom 02):1.7.6` | [S] + [V] strings |
| ESP-AT 2.2.x on ESP8285 1 MB | `AT version:2.2.2.0-dev(e3958a6 - ESP8266 - Oct 30 2024 02:42:04)` / `SDK version:v3.4-84-ge19ff9af` / `compile time(f37fbc77):Nov  5 2024 15:58:02` / `Bin version:2.2.1(ESP8266_1MB)` | [S] (sigmdel, ESP-01S) |
| ESP-AT on ESP32-C3 (ours) | `Bin version: v3.3.0.0(MINI-1)` [M]; full format per a 4.2 upgrade on the same module type: `AT version:4.2.0.0(9b8caf0 - ESP32C3 - Aug  7 2026 06:52:24)` / `SDK version:v5.4.4` / `compile time(8a803bdb):...` / `Bin version:v4.2.0.0(MINI-1)` | [M] / [S] (fabianhugo notes in `%TEMP%\iot-ext-research\pxt-wifi@AP_mode\pythonTools\docs\`) |

"Bin version(Wroom 02)" is a hard-coded string in Espressif's NonOS AT example (`ESP_AT_FW_VERSION` in `examples/at/include/user_config.h`), so it also appears on ESP8285 modules [V].

### 1.3 Seeed's MakeCode driver (`pxt-grove` main.ts 703-867)

Transport: `serial.redirect(tx, rx, baud)`, defaults `P15`/`P1`/115200. Every command is written as `cmd + "\r\n"`. `waitAtResponse(t1, t2, t3, timeout)` appends `serial.readString()` to a string every 100 ms and returns 1/2/3 for the first target found anywhere in the accumulated buffer (checked in that order), 0 on timeout [V].

| Step | Command sent | Waits for (1 / 2 / 3), timeout | Notes |
|---|---|---|---|
| setupWifi | `AT` | `OK` / `ERROR` / –, 1 s | Result ignored. No `ATE0`, no wait for `ready`. |
| | `AT+CWMODE=1` | `OK` / `ERROR`, 1 s | Deprecated alias of `_DEF` on NonOS: persisted in flash (only if changed) [V]. |
| | `AT+CWJAP="<ssid>","<pwd>"` | `WIFI GOT IP` / `ERROR`, 20 s | Success detected via the URC. NonOS ends a failed join with `FAIL`, not `ERROR` [V], so a wrong password costs the full 20 s. No escaping of `,` `"` `\`. Credentials persisted (deprecated = `_DEF`) [V]. |
| ThingSpeak / IFTTT | `AT+CIPCLOSE` (if connected) | `OK` / `ERROR`, 2 s | Closes the connection left open by the previous call. |
| | `AT+CIPSTART="TCP","api.thingspeak.com",80` | `OK` / `ALREADY CONNECTED` / `ERROR`, 2 s | Only result 3 (`ERROR`) retries. `ALREADY CONNECTED` is followed by `ERROR` on NonOS [I] but matches target 2 first. A timeout (DNS + connect > 2 s) is treated as success. |
| | `AT+CIPSEND=<len+2>` | `>` / `OK` / `ERROR`, 2 s | If a read returns `OK` before `>` arrives, it proceeds and sends the payload too early (the "`OK` instead of `>`" trap). |
| | payload (`GET /update?...` or an HTTP/1.1 request) + `\r\n` | `SEND OK` / `SEND FAIL` / `ERROR`, 5 s | The HTTP response (`+IPD,...`) is never read; it lands in the next wait buffer, where `OK`/`ERROR` inside the body can produce false matches. |

`isWifiConnected` is set once and never cleared on `WIFI DISCONNECT`; `busy p...` and `ready` are ignored. The driver works on both families only because it uses the common subset `AT`, `AT+CWMODE=1`, `AT+CWJAP=`, `AT+CIPSTART`, `AT+CIPSEND`, `AT+CIPCLOSE`, which exists unchanged from AT 0.24 through ESP-AT 3.x [V: Seeed 0.24 binary and ESP-AT docs].

---

## 2. Capability table

Columns: **C3** = ESP32-C3-MINI-1, ESP-AT 3.3.0.0 (our module). **1.6** = ESP8266/8285 NonOS AT 1.6.x (likely Grove V2 stock). **1.7** = NonOS AT 1.7.x (1.7.4-1.7.6; on 1 MB flash only the "nano" build). **E2** = ESP-AT 2.2/2.3 for ESP8266 (e.g. `ESP8266_1MB` build on an ESP8285).

| Capability | C3 (ESP-AT 3.3) | 1.6 (NonOS) | 1.7 (NonOS) | E2 (ESP-AT 2.x on 8266) |
|---|---|---|---|---|
| Fits 1 MB ESP8285 | n/a (4 MB) | yes, 512+512 map [V] | only the nano build (3.0.4+) [V] | yes, `ESP8266_1MB`, no OTA [V] |
| Wi-Fi mode | `CWMODE=<0-3>`; 0 = RF off [V] | `CWMODE_CUR`/`_DEF` 1-3; `CWMODE` = `_DEF` [V] | same [V] | `CWMODE=<0-3>` [V] |
| Join | `CWJAP` [V] | `CWJAP_CUR` / `_DEF`; `CWJAP` = `_DEF` [V] | same [V] | `CWJAP` [V] |
| Join failure | `+CWJAP:<n>` + `ERROR` [V] | `+CWJAP_CUR:<n>` + `FAIL`; codes "not reliable" [V] | same; wrong codes fixed in 1.7.5 [V] | `+CWJAP:<n>` + `ERROR`; code fix in 2.2.2.0 [V] |
| Flash-write control | `SYSSTORE=0/1` [V][M] | `_CUR` vs `_DEF` [V] | same [V] | `SYSSTORE` (since 2.1.0) [V] |
| Wi-Fi status query | `CWSTATE?` [V][M], `CWJAP?`, `CIPSTATE?` | `CWJAP_CUR?` (`No AP`), `CIPSTATUS` (`STATUS:2-5`) [V] | same [V] | `CWSTATE?` (since 2.2.0), `CIPSTATE?` (2.2.2.0) [V] |
| Auto-connect | `CWAUTOCONN`, always saved in NVS [V] | `CWAUTOCONN`, saved, default 1 [V] | same [V] | same [V] |
| RF off at boot | persist `CWMODE=0` [V] | not possible via AT [I] | not possible via AT [I] | persist `CWMODE=0` (power fix in 2.2.2.0) [V] |
| TCP client | `CIPSTART` "TCP"/"SSL" [V] | same [V] | same [V] | same [V] |
| Max `CIPSEND` | 8192 bytes [V] | 2048 [V] | 2048 [V] | 2048 [V] |
| Active `+IPD` | `+IPD,<len>:<data>`, ≤ 2920 B per URC [V] | `+IPD,<len>:<data>` [V] | same [V] | same [V] |
| Passive receive | `CIPRECVMODE` [M]; documented name `CIPRECVTYPE` since 3.3.0.0 [V] | **none** [V] | `CIPRECVMODE/DATA/LEN`, 2920 B buffer (TCP only, not SSL) [V] | `CIPRECVMODE/DATA/LEN`, 5760 B window [V] |
| HTTP client (`HTTPCLIENT`, `HTTPCPOST`) | yes [M] | no [V] | no [V] | not in Espressif's ESP8266 builds (Kconfig default n) [V] |
| TLS library | mbedTLS (IDF 5.0) [I] | Espressif `libssl` (axTLS-derived), RSA only [V strings] / [I] | 2 MB+: mbedTLS, only RSA and DHE-RSA with AES-CBC; 1 MB nano: axTLS-derived [V strings] | mbedTLS; ECDHE-RSA/ECDSA and GCM on by default; 16 KB input buffer [V config] |
| TLS to `campus-api` | works [M] | no [V server] + [I client] | no [V server] + [I client] | likely, untested [I] |
| `CIPSSLSIZE` | not present [V] | 2048-4096 [V] | 2048-4096 [V] | not present [V] |
| SNI | `CIPSSLCSNI` [V] | none known [I] | none known [I] | `CIPSSLCSNI` [V] |
| SNTP | `CIPSNTPCFG` / `CIPSNTPTIME?` [V][M] | yes (since AT 1.4 / SDK 2.1.0) [V] | yes [V] | yes [V] |
| `UART_CUR` | 80 … SoC max [V] | 110 … 4 608 000 [V] | same [V] | 80 … 4 500 000 [V] |
| `AT+SLEEP` numbering | 0 off, 1 modem, 2 light, 3 modem/listen [V] | 0 off, **1 light, 2 modem** [V] | same [V] | ESP-AT numbering [V] |
| Busy messages | `busy p...` [V] | `busy p...`, `busy s...` [V] | same [V] | `busy p...` [V] |
| Boot output on AT port | `ready` only; ROM/app logs go to UART0 [V pins] / [I] | ROM log at 74880 baud (garbage at 115200), then `ready` [V strings] / [S baud] | same | ROM garbage + `ready` if re-pinned to UART0 [I] |
| `AT+CMD?` (list commands) | yes [V] | no [V] | no [V] | yes [V] |

---

## 3. Command and response reference (subset we need)

Line terminator is `\r\n` everywhere. Commands must be upper case and end with CR LF [V]. Responses are usually surrounded by blank lines; parse line by line and ignore empty lines.

### 3.1 Boot, `AT`, `ATE0`

| | NonOS 1.x | ESP-AT 2.x/3.x |
|---|---|---|
| Power-on | ESP8266/8285 ROM prints its boot log at **74880** baud with a 26 MHz crystal (the Grove V2 uses one [V schematic]); at 115200 this is garbage. The AT app then prints `ready` at 115200 [V string] / [S baud]. | C3: AT on UART1 (MINI-1: TX GPIO7, RX GPIO6), logs on UART0 [V]. The AT port sees only `ready` [I]. |
| `AT+RST` | `OK`, then the same boot sequence, then `ready` [V] | `OK` ... `ready` [V] |
| `AT` | `OK` [V] | `OK` [V] |
| `ATE0` | `OK` (echo off, not persisted) [V] | same [V] |

Driver rule: after power-up or `AT+RST`, drop all bytes (including non-ASCII) until a line equal to `ready`, or until ~2 s pass, then poll `AT` a few times. Do not assume a clean first line.

### 3.2 `AT+GMR`

NonOS: `<AT version info>` / `<SDK version info>` / `<compile time>` [V doc], plus `Bin version(Wroom 02):1.x.y` in 1.6.0+ [V strings]. ESP-AT: adds `Bin version:<ver>(<module>)`; the AT version line carries `(<hash> - <CHIP> - <date>)` [V]. Examples in §1.2.

### 3.3 `AT+UART_CUR`

- `AT+UART_CUR=<baud>,<databits>,<stopbits>,<parity>,<flow>` → `OK`; not saved [V]. Typical: `AT+UART_CUR=57600,8,1,0,0`.
- `OK` is sent at the old rate; switch the host afterwards [I].
- NonOS: `AT+UART_CUR?` may report a slightly different actual rate (e.g. 115273) [V].
- Avoid `AT+UART_DEF` (saved) and deprecated `AT+UART`.

### 3.4 Wi-Fi mode

| NonOS | ESP-AT |
|---|---|
| `AT+CWMODE_CUR=1` → `OK` (RAM). `AT+CWMODE_DEF=1` → `OK` (flash). Query `AT+CWMODE_CUR?` → `+CWMODE_CUR:<mode>`. Modes 1 STA, 2 AP, 3 both; no 0 [V]. | `AT+CWMODE=<mode>[,<auto_connect>]` → `OK`; saved only if `SYSSTORE=1`. Mode 0 = "Null mode. Wi-Fi RF will be disabled." Query `+CWMODE:<mode>` [V]. |

### 3.5 Join

**NonOS** [V doc]:

```
AT+CWJAP_CUR="<ssid>","<pwd>"[,"<bssid>"][,<pci_en>]
→ WIFI CONNECTED          (URC)                          [V string]
  WIFI GOT IP             (URC)                          [V string]
  OK
or
  +CWJAP_CUR:<code>       1 timeout, 2 wrong password, 3 AP not found, 4 connection failed
  FAIL
```

- `AT+CWJAP_DEF=...` has the same syntax and response, but is saved in flash.
- Deprecated `AT+CWJAP=...` behaves like `_DEF` and answers `+CWJAP:<code>` / `FAIL` [V, 1.5.4 doc].
- If already connected, expect `WIFI DISCONNECT` before `WIFI CONNECTED` [I].
- The codes are "for reference only"; 1.7.5 fixed wrongly reported codes [V]. Accept `+CWJAP(_CUR|_DEF)?:<n>`.
- Query `AT+CWJAP_CUR?` → `+CWJAP_CUR:"<ssid>","<bssid>",<ch>,<rssi>` / `OK`, or `No AP` / `OK` [V doc + string].
- Escaping: `,` `"` `\` must be written as `\,` `\"` `\\` [V].

**ESP-AT** [V]:

```
AT+CWJAP=[<"ssid">],[<"pwd">][,<"bssid">][,<authmode>][,<reconn_interval>][,<listen_interval>][,<scan_mode>][,<jap_timeout>][,<pmf>]
→ WIFI CONNECTED / WIFI GOT IP / OK      or      +CWJAP:<code> / ERROR
```

- Codes 1-4 as above, "others: unknown".
- `jap_timeout` defaults to 15 s. `reconn_interval` defaults to 1 s (automatic reconnect).
- Saved only if `SYSSTORE=1`.

### 3.6 Auto-connect

- NonOS: `AT+CWAUTOCONN=<0|1>` → `OK`. Default 1. Saved in the system parameter area. Only a set command is documented [V].
- ESP-AT: `AT+CWAUTOCONN=<0|1>` → `OK`, query `+CWAUTOCONN:<n>`. Always saved in NVS, independent of `SYSSTORE`. Espressif itself recommends 0 for power-sensitive designs [V].
- NonOS writes flash only when a value changes ("users need not be concerned about wearing out the flash on repeated application of commands that set the same default configurations") [V, docs 1.5.4 and 3.0.x]. NonOS SDK 3.0.2 also stores Wi-Fi parameters only when they differ [V].

### 3.7 Status

- **ESP-AT** `AT+CWSTATE?` → `+CWSTATE:<state>,"<ssid>"` / `OK` [V]. States:
  - 0 not started
  - 1 connected, no IPv4 yet
  - 2 connected with IPv4
  - 3 connecting or reconnecting
  - 4 disconnected
- **NonOS** has **no `CWSTATE` equivalent** [V]. Use:
  - `AT+CIPSTATUS` → `STATUS:<stat>` then `+CIPSTATUS:<id>,"<type>","<ip>",<rport>,<lport>,<tetype>` lines, then `OK`. Values of `<stat>`: 2 got IP, 3 TCP/UDP link exists, 4 link closed, 5 not connected to an AP [V].
  - `AT+CWJAP_CUR?` (SSID or `No AP`), and the local IP via `AT+CIPSTA_CUR?` → `+CIPSTA_CUR:ip:"a.b.c.d"` (+ gateway, netmask) or `AT+CIFSR` → `+CIFSR:STAIP,"a.b.c.d"` [V format strings].
- ESP-AT keeps `CIPSTATUS` (deprecated) with `<stat>` 0-5 [V].

### 3.8 `AT+SYSSTORE` (ESP-AT only)

- `AT+SYSSTORE=<0|1>` → `OK`; query `+SYSSTORE:<n>` [V].
- It affects set commands such as `CWMODE`, `CWJAP`, `CIPSTA`, `CIPDNS`, `CIPSSLCCONF`, `CWDHCP`; `CWAUTOCONN` is not on the list [V].
- The factory default is 1 (from `factory_param_data.csv`) [V]. Whether a value of 0 survives a reboot is not documented: send it on every start [I].
- NonOS: `AT+SYSSTORE` does not exist and answers `ERROR` [V: absent from all scanned binaries].

### 3.9 `AT+CIPSTART`, `AT+CIPSSLSIZE`

```
AT+CIPSTART="TCP","<host or ip>",<port>[,<keepalive>]           (CIPMUX=0)
→ CONNECT
  OK
or  ALREADY CONNECTED / ERROR       (link exists)
or  DNS Fail / ERROR                (NonOS: name not resolved)
or  ERROR / CLOSED                  (connect failed)
```

- The strings `CONNECT`, `ALREADY CONNECTED`, `DNS Fail`, `CONNECT FAIL`, `no ip`, `link is not valid` are all present in the 1.6.2 and 1.7.6 binaries [V]. The exact line order for the error cases is [I].
- ESP-AT answers the same way, with extra optional `<local IP>` and `<timeout>` parameters and `+ERRNO:` detail when `AT+SYSLOG=1` [V].
- SSL (NonOS):
  - `AT+CIPSSLSIZE=<2048..4096>` → `OK` before `AT+CIPSTART="SSL",...` [V].
  - Only one SSL link [V]. No passthrough mode on SSL [V].
  - "If the SSL encrypted packet size is larger than ESP8266's SSL buffer size ..., the SSL connection will fail" [V, SSL User Manual].

### 3.10 `AT+CIPSEND`

```
AT+CIPSEND=<len>            NonOS max 2048, ESP-AT C3 max 8192, ESP-AT on ESP8266 max 2048
→ OK
  >                         wait for this before sending data
<len raw bytes>
→ Recv <len> bytes          [V string, both families]
  SEND OK                   or SEND FAIL / ERROR
```

- `SEND OK` means "handed to the protocol stack", not delivered to the peer [V ESP-AT].
- NonOS prints `busy s...` if input arrives while it is still sending [V]. `SEND Canceled` exists in both firmwares [V].
- Never send payload bytes before `>`.

### 3.11 Receiving: `+IPD` and passive mode

**Active mode**, all versions [V]:

```
+IPD,<len>:<data>                       (CIPMUX=0)
+IPD,<id>,<len>:<data>                  (CIPMUX=1)
+IPD,<len>,<ip>,<port>:<data>           (with AT+CIPDINFO=1)
```

- `<data>` is raw binary and may contain CR LF, `OK`, `ERROR`. Read exactly `<len>` bytes after `:`.
- One HTTP response usually arrives as several `+IPD` blocks (one per TCP segment) [I]. `CLOSED` can follow at any time.

**Passive mode, NonOS 1.7.0+** [V]:

- `AT+CIPRECVMODE=1` → `OK`. TCP only (not SSL, not UDP). Internal buffer 2920 bytes; when it is full the TCP window closes.
- Notification `+IPD,<len>` (no data; `<len>` = total buffered).
- `AT+CIPRECVDATA=<len≤2048>` is documented as `+CIPRECVDATA:<actual_len>,<data>` / `OK`. However, the 1.7.x binaries contain the format string `"\r\n%s,%d:"` (only present in builds that have `CIPRECVDATA`), which suggests the real output is **`+CIPRECVDATA,<actual_len>:<data>`** [I]. The parser should accept both separators.
- `AT+CIPRECVLEN?` → `+CIPRECVLEN:<l0>,<l1>,<l2>,<l3>,<l4>` / `OK`.
- Buffered data survives a disconnect until a new connection reuses the link ID [V].

**Passive mode, ESP-AT** [V]:

- `AT+CIPRECVMODE=1` (works on our 3.3.0.0 [M]). From 3.3.0.0 on, the documented command is `AT+CIPRECVTYPE=<mode>` (`AT+CIPRECVTYPE=<link>,<mode>` with CIPMUX=1).
- `+IPD,<len>` notification. The next `+IPD` is only reported after the previous data was read.
- `AT+CIPRECVDATA=<len>` → `+CIPRECVDATA:<actual_len>,<data>` / `OK`. It returns `ERROR` if nothing is buffered.
- `CLOSED` is withheld until the buffer is read or `CIPCLOSE` is sent.
- The window is 5760 bytes (both C3 and ESP8266).

### 3.12 `AT+CIPCLOSE`

`AT+CIPCLOSE` (single) or `AT+CIPCLOSE=<id>` (5 = all) → `CLOSED` / `OK`, or `ERROR` if no link exists [V] (line order [I]).

### 3.13 SNTP

- NonOS (1.4+): `AT+CIPSNTPCFG=1,<tz -11..13>[,"s0","s1","s2"]` → `OK`. `AT+CIPSNTPTIME?` → `+CIPSNTPTIME:Thu Aug 04 14:48:05 2016` / `OK` [V].
- ESP-AT: same commands, plus `+TIME_UPDATED` URC and `AT+SYSTIMESTAMP` [V].
- Not needed: the server supplies the time.

### 3.14 Sleep

- NonOS: `AT+SLEEP=<0 off | 1 light | 2 modem>`, station only; modem-sleep is the default [V].
- ESP-AT: `AT+SLEEP=<0 off | 1 modem(DTIM) | 2 light | 3 modem(listen interval)>` [V].
- **Map by family.**

### 3.15 URCs and busy handling

| Message | NonOS 1.x | ESP-AT | Meaning |
|---|---|---|---|
| `ready` | [V] | [V] | firmware up (after power-on / reset / crash) |
| `WIFI CONNECTED`, `WIFI GOT IP`, `WIFI DISCONNECT` | [V] (also in 0.24) | [V] | station state |
| `CONNECT` / `<id>,CONNECT` | [V] | [V] | link up |
| `CLOSED` / `<id>,CLOSED` | [V] | [V] | link down |
| `+IPD,...` | [V] | [V] | data / data waiting |
| `busy p...` | [V] | [V] | still processing the previous command; the new input is discarded |
| `busy s...` | [V] | not listed | still sending data |
| `+LINK_CONN:...` | with `AT+SYSMSG_CUR=2` (1.7) [V] | with `AT+SYSMSG` [V] | detailed link info |
| `+STA_CONNECTED` etc. | [V] | [V] | soft-AP only (irrelevant) |

Rule for both: one command in flight; wait for its final line (`OK`, `ERROR`, `FAIL`, `SEND OK`, `SEND FAIL`) before sending the next one; on `busy p...` back off (e.g. 200 ms) and resend [I].

### 3.16 `AT+HTTPCPOST` (ESP-AT only; primary path on the C3)

```
AT+HTTPCPOST=<"url">,<length>[,<header_cnt>,<"header">...]
→ OK
  >
<body bytes>
→ +HTTPCPOST:<n>,<data>      (response body, may repeat; no status line, no headers)   [M]
  SEND OK   |   SEND FAIL
```

- The default content type is `application/x-www-form-urlencoded`: pass `"Content-Type: application/json"` as a header [V].
- If the whole command is longer than 256 bytes, preset the URL with `AT+HTTPURLCFG` [V].
- Each call opens a new connection, i.e. a full TLS handshake per request [V].

---

## 4. TLS feasibility against `campus-api.calliope.cc` (probe 2026-09-29)

Tool: `openssl s_client` 3.1.2 from this machine [V]:

| Test | Result |
|---|---|
| Protocols | TLS 1.2 and 1.3 offered. |
| TLS 1.2 suites accepted | ECDHE-RSA-AES128-GCM-SHA256, ECDHE-RSA-AES256-GCM-SHA384, ECDHE-RSA-CHACHA20-POLY1305, ECDHE-RSA-AES128-SHA |
| TLS 1.2 suites rejected (handshake alert 40) | AES128-SHA, AES256-SHA, AES128-SHA256 (static RSA); DHE-RSA-AES128-SHA, DHE-RSA-AES128-SHA256, DHE-RSA-AES256-SHA256; ECDHE-RSA-AES128-SHA256; all ECDSA (no ECDSA certificate) |
| Certificate chain | leaf RSA-4096 (1547 B DER) → Let's Encrypt YR2 (1246 B) → Root YR cross-signed by ISRG Root X1 (1528 B): 4321 B total |
| Max Fragment Length | client offered `-maxfraglen 2048`; server did not echo the extension (Traefik/Go ignores it) |
| No SNI | server returns `TRAEFIK DEFAULT CERT` |

What each client firmware brings:

- **NonOS 1.6.x and 1.7 nano (1 MB):** Espressif `libssl` (strings `ssl_tls1.c`, `ssl_x509.c`, `ssl_rsa.c`, `ssl_bigint.c`, no ECC module) → RSA key exchange only [V strings] / [I].
- **NonOS 1.7.6 full (2 MB+):** mbedTLS with exactly these suites compiled in: `TLS-DHE-RSA-WITH-AES-128/256-CBC-SHA(256)`, `TLS-RSA-WITH-AES-128/256-CBC-SHA(256)`, RSA-PSK [V strings]. No ECDHE.

The TLS buffer is at most 4096 B (`CIPSSLSIZE`), below the 4.3 KB Certificate record [V].

**Verdict:** NonOS AT cannot reach the production server over TLS: no common cipher suite, and the record size is too large [V server side, I client side]. The ESP8285 path must use plain http (local or self-hosted servers, or an http endpoint if we decide to offer one). ESP-AT 2.x on ESP8266 has ECDHE, GCM and ECDSA enabled by default in the RTOS SDK mbedTLS Kconfig, and the 1 MB config sets `CONFIG_MBEDTLS_SSL_IN_CONTENT_LEN=16384` [V]. With `CIPSTART "SSL"` it should work, heap permitting [I, test needed].

---

## 5. Detection strategy

Do this after `ready`, `AT` → `OK`, `ATE0`:

1. Send `AT+GMR` and collect lines until `OK` (timeout 2 s).
2. Parse the version:

   ```
   /AT version:(\d+)\.(\d+)\.(\d+)\.(\d+)/      → major, minor
   /SDK version:\s*(\S+)/                        → sdk
   /Bin version[^:]*:\s*v?([\d.]+)\s*(?:\(([^)]*)\))?/ → bin, module   (tolerate "Bin version: v3.3.0.0(MINI-1)")
   /\(\s*\w+\s*-\s*(ESP[\w-]+)\s*-/             → chip, ESP-AT only
   /SeeedStudio/                                 → Seeed custom build
   ```

   Stop the version capture at `(`; a naive `\S+` captures `4.1.1.0(abc` [S].
3. Classify:

   | Condition | Family | Notes |
   |---|---|---|
   | major ≥ 2 | **ESPAT** | chip from `(… - ESP32C3 - …)` / `(… - ESP8266 - …)` or module name (`MINI-1`, `ESP8266_1MB`) |
   | major = 1, minor ≥ 7 | **NONOS17** | passive receive available |
   | major = 1, minor < 7 | **NONOS16** | active `+IPD` only |
   | major = 0 | **NONOS0** | treat as NONOS16; `_CUR` commands and `WIFI GOT IP` exist in 0.24 [V] |
   | no match | probe | `AT+SYSSTORE?` → `+SYSSTORE:` ⇒ ESPAT; else `AT+CWMODE_CUR?` → `+CWMODE_CUR:` ⇒ NONOS16 |

4. Probe instead of assuming. Cheap query forms answer `ERROR` when a command is missing, on both families:
   - ESPAT receive mode: `AT+CIPRECVTYPE?` → if `+CIPRECVTYPE:`, use `CIPRECVTYPE`; else `AT+CIPRECVMODE?` → if `+CIPRECVMODE:`, use `CIPRECVMODE`.
   - ESPAT HTTP client: assume present for chip ≠ ESP8266; confirm with a streaming scan of `AT+CMD?` for `"AT+HTTPCPOST"` (output about 200 lines, `+CMD:<i>,"<name>",t,q,s,e` [V]), or treat the first `ERROR` on `AT+HTTPCPOST` as "absent" and fall back to TCP.
   - NONOS17: `AT+CIPRECVMODE?` → `+CIPRECVMODE:0` confirms (a Seeed build might differ) [I].
5. Resulting flags:

   ```ts
   caps.family   = ESPAT | NONOS17 | NONOS16
   caps.store    = family == ESPAT ? "SYSSTORE" : "CUR"          // command suffix strategy
   caps.passive  = family == ESPAT || family == NONOS17
   caps.recvCmd  = "CIPRECVTYPE" | "CIPRECVMODE" | null
   caps.http     = family == ESPAT && chip != ESP8266 (then confirmed)
   caps.tls      = family == ESPAT                               // NonOS: never use SSL
   caps.maxSend  = (family == ESPAT && chip != ESP8266) ? 8192 : 2048
   caps.joinFail = family == ESPAT ? "ERROR" : "FAIL"
   caps.sleep    = family == ESPAT ? {modem: 1, light: 2} : {light: 1, modem: 2}
   ```

---

## 6. Recommended command sets

### 6.1 ESP-AT (ESP32-C3 3.x; also ESP-AT 2.x on ESP8285)

Start:

1. Wait for `ready` (≤ 2 s), then `AT` → `OK` (up to 5 tries, 300 ms apart).
2. `ATE0`, then `AT+GMR` (§5), then probes.
3. `AT+SYSSTORE=0` so that nothing below touches flash.
4. `AT+CWAUTOCONN?` → if `1`, send `AT+CWAUTOCONN=0` (one NVS write, once per module).
5. Optional one-time boot-power trick, see §8.4 [I]: `AT+SYSSTORE=1`, `AT+CWMODE=0`, `AT+SYSSTORE=0`. The stored mode then stays 0 and every later `CWMODE=1` stays in RAM.
6. `AT+CWMODE?` → if not 1: `AT+CWMODE=1,0` (the second argument suppresses auto-join; documented in current ESP-AT, not yet checked on 3.3.0.0 [I]).

Join:

7. `AT+CWSTATE?` → `+CWSTATE:2,"<ssid>"` with our SSID ⇒ skip joining.
8. `AT+CWJAP="<ssid>","<pwd>"`, escaped → final `OK` or `+CWJAP:<n>` / `ERROR`; host timeout ≥ 17 s.
9. After `WIFI DISCONNECT`, the firmware reconnects on its own (`reconn_interval` 1 s): wait for `WIFI GOT IP` with a back-off before sending `CWJAP` again [I].

Traffic:

10. Primary: `AT+HTTPCPOST` (§3.16), for http and https.
11. Fallback without an HTTP client:
    - `AT+CIPMUX=0`, then `AT+CIPRECVTYPE=1` (or `CIPRECVMODE=1`)
    - `AT+CIPSTART="SSL"|"TCP",...`
    - `AT+CIPSEND=<n>` → `>` → request (`Connection: close`)
    - on each `+IPD,<len>`: `AT+CIPRECVDATA=<len>`
    - until `CLOSED`.

### 6.2 NonOS 1.7.x

1. Wait for `ready`, discarding garbage; `AT` → `OK`; `ATE0`; `AT+GMR`.
2. `AT+CWMODE_DEF=1`. This writes flash only if the stored mode differs, and it removes a soft-AP that NonOS may bring up at boot [I]. Use `AT+CWMODE_CUR=1` if zero flash writes are preferred.
3. `AT+CWAUTOCONN=0` (write only on change) [V].
4. Status: `AT+CWJAP_CUR?` (`+CWJAP_CUR:"<ssid>",...` or `No AP`) and `AT+CIPSTATUS` (`STATUS:2` = has IP).
5. `AT+CWJAP_CUR="<ssid>","<pwd>"` → `OK` or `+CWJAP_CUR:<n>` / **`FAIL`**; timeout 20 s. Never plain `AT+CWJAP` (flash).
6. `AT+CIPMUX=0`, `AT+CIPRECVMODE=1`.
7. `AT+CIPSTART="TCP","<host>",<port>` → `CONNECT` / `OK`.
8. `AT+CIPSEND=<n ≤ 2048>` → `>` → request → `Recv n bytes` / `SEND OK`. Split larger batches.
9. On `+IPD,<len>`: `AT+CIPRECVDATA=<min(len,2048)>`; parse `+CIPRECVDATA[,:]<n>[,:]<data>` by length; repeat until the buffer is empty.
10. `AT+CIPCLOSE` (or wait for `CLOSED`).
11. Never `SSL` (§4).

### 6.3 NonOS 1.6.x / 0.x (the likely Grove V2 stock)

Same as 6.2 without step 6's `CIPRECVMODE`. Receiving is active only:

- Parse `+IPD,<len>:` headers in the stream and consume exactly `<len>` bytes. Several blocks per response. `CLOSED` may be interleaved.
- Keep responses small. The ingest reply was 227-464 bytes [M], which fits a 254-byte host RX buffer only if it is drained promptly.
- Send `Connection: close` and treat `CLOSED` as end of response.
- If overruns appear, lower the link rate with `AT+UART_CUR=57600,8,1,0,0` (or 38400) after start-up [I].
- Poll the UART much faster than 100 ms while a response is expected.

---

## 7. ESP-AT 2.x on the Grove V2 (question 4)

**Availability** [V]:

- ESP-AT for ESP8266 exists on the `release/v2.2.0.0_esp8266` branch. Releases: v2.0.0.0 (2019), v2.1.0.0 (2020), v2.2.0.0 / v2.2.1.0 (2021), **v2.2.2.0_esp8266 (2025-03)** and **v2.3.0.0_esp8266 (2025-08)**.
- v2.3.0.0 moves to mbedTLS ~3.6.3 and adds `AT+CIPSSLCCIPHER`.
- Official ready-made binaries: only ESP-WROOM-02 (2 MB).
- 1 MB: "Espressif has not released a separate version for the 1 MB ESP8285/8266 series"; use the CI artifact `esp8285-1MB-at` or build it yourself.

**The `ESP8266_1MB` configuration** (`module_config/module_esp8266_1mb`) [V]:

- DOUT flash at 80 MHz, 1 MB, factory app partition 0xE0000 (896 KB), no OTA, MQTT on, HTTP off (`AT_HTTP_COMMAND_SUPPORT` default n).
- `CONFIG_AT_PROCESS_TASK_STACK_SIZE=1792`. HTTPS through `HTTPCLIENT` would need > 4096, "otherwise ESP8266 will restart".
- Supported chips per Espressif's table: ESP8285N08, ESP8285H08, ESP8285H16.
- **Default AT UART is swapped UART0 on GPIO15 (TX) / GPIO13 (RX) with CTS 3 / RTS 1.** The Grove V2 routes GPIO1/GPIO3 (U0TXD/U0RXD) to the connector [V schematic], so the image must be patched with `at.py modify_bin -tx 1 -rx 3 …` (as sigmdel did for the ESP-01S) [S].

**Proven in practice:**

- Carmine Noviello flashed a self-compiled ESP-AT 2.2.1 onto a Grove V2 with the Flash Download Tool (chip type ESP8285) [S].
- sigmdel runs 2.2.2.0-dev (`ESP8266_1MB`) on a 1 MB ESP-01S [S].
- A wrong flash mode gives `csum err` and a "bricked" module; it is recoverable with DOUT [S].

**What it gains over stock 1.6:**

- passive receive
- `SYSSTORE`, `CWSTATE`, `CIPSTATE`, `CWMODE=0`, `AT+CMD?`
- the same syntax as the C3, so no `_CUR` branch in the driver
- modern TLS (ECDHE, GCM, 16 KB records, `CIPSSLCSNI`), so https to `campus-api` becomes plausible via `CIPSTART "SSL"` [I]
- MQTT

What it does not gain: `HTTPCLIENT` / `HTTPCPOST`.

**Cost:**

- One USB-serial adapter per module, the boot button, and a custom image.
- Not feasible for schools. Flashing through the Calliope as a serial bridge is theoretically possible, but it is a project of its own.

**Cheaper intermediate path, untested** [I]: NonOS 1.6.x supports `AT+CIUPDATE` (cloud OTA) on the 512+512 layout. sigmdel upgraded 1.7.4 → 1.7.6 this way in 2024 [S], but could not upgrade 1.3.0 [S]. If Espressif's server still serves a 1 MB image, 1.6.2 → 1.7.x nano would bring `CIPRECVMODE` without extra hardware. Try once on a spare module.

**Recommendation:** support stock NonOS (http only) as the ESP8285 path. An ESP8285 re-flashed to ESP-AT 2.x is detected as ESPAT with `chip = ESP8266` and gets passive receive and TLS through the same code as the C3, minus `HTTPCPOST`.

---

## 8. Electrical notes

### 8.1 Module figures

| | ESP32-C3-MINI-1 | Grove UART WiFi V2 (ESP8285) |
|---|---|---|
| Supply | VDD33 3.0-3.6 V; "Current delivered by external power supply ≥ 0.5 A" [V datasheet v1.3] | Board input "3V / 5V" [V wiki]; on-board **ETA3410** synchronous buck: 2.6-5.5 V in, output up to VIN (i.e. passes through at 3.3 V in), internal soft-start "reduces inrush current", UVLO 1.9/2.1 V, feedback 100k/22k → 3.33 V [V schematic + datasheet]. Chip: 2.7-3.6 V (ESP8285 datasheet 2023; older revisions 3.0 V or 2.5 V) [V] |
| TX peak | 802.11b 1 Mbps @20.5 dBm **350 mA**; 11g 54M 295 mA; 11n MCS7 290 mA (peak, 100 % duty) [V] | 802.11b 11 Mbps @+19 dBm **197 mA**; 11g 147 mA; 11n 142 mA (typ., 3.0 V, "based on a 50% duty cycle") [V]; instantaneous peaks higher [I] |
| RX | 82-84 mA [V] | 72-73 mA [V] |
| Bulk capacitance | module only; depends on the carrier board [I] | 2×10 µF at the buck input, 2×10 µF at its output, 10 µF at the chip [V schematic] |
| UART on the connector | UART1 (GPIO6/7) at 115200 [V] | UART0 (GPIO1/3); RX through a 2N7002 level shifter [V schematic] |

Check the ESP32-C3 carrier board: if it puts an LDO behind the Grove VCC pin, 3.3 V in leaves < 3.0 V at the module during TX [I].

### 8.2 Calliope mini 3 supply (published schematic, sheet "Power and Monitoring") [V]

- USB 5 V → BAT60J Schottky → `VCOMBINED` → **NCP114ASN330** LDO (3.3 V, 300 mA rated; current limit min 300 / **typ 600 mA**; dropout 135 mV typ @ 300 mA; load transient −50 mV for a 1 → 300 mA step) → `VCC` with 4.7 µF output cap. [V NCP114 datasheet]
- Battery JST → BAT60A → BAT60A → `VCOMBINED` → same LDO. The mini 3 accepts up to 5 V there (LiPo possible) [V docs].
- VM pin → AP2210 3.3 V LDO → BAT60A → `VCOMBINED` [V].
- Both Grove connectors take their power pin **directly from `VCC`** [V sheet "Connectors"]. The LSM303AGR (accelerometer + magnetometer, internal I2C) and the RGB LEDs are also on `VCC` [V].
- Calliope docs: external loads may draw **200 mA in total with the RGB LEDs off**; in battery operation `VCC` depends on the battery charge [V].
- BAT60A forward voltage ~0.12 V @ 10 mA, ~0.2 V @ 100 mA, ~0.3 V @ 1 A [S].

### 8.3 Can the Grove port brown out? [I]

- **USB-powered:**
  - C3 at 350 mA plus the board (≤ 60 mA, more with RGB LEDs) exceeds both the documented 200 mA budget and the LDO's guaranteed 300 mA. It usually works because the typical limit is 600 mA, but every TX burst dips the rail.
  - If the demand exceeds the actual current limit, `VCC` collapses within microseconds (≈ ΔI/C with ~5-30 µF on the rail) until the ESP32-C3 brown-out detector resets it. The ESP reboots and draws again: a reset loop.
  - The Grove V2 (~200 mA) stays inside the typical limit.
  - Thermal: (4.7 − 3.3) V × 0.4 A ≈ 0.56 W in a SOT-23-5 during bursts. Fine for bursts, not for continuous TX.
- **2×AAA:** `VCC` ≈ V_bat − 2×V_F(BAT60A) − LDO dropout, i.e. about 2.7 V at light load and about 2.3-2.5 V at 300 mA with fresh cells. That is below the C3's 3.0 V minimum even at idle, and at or below the ESP8285's 2.7 V minimum under TX. **ESP32-C3 WiFi on 2×AAA is out of spec.** Use USB, or a LiPo on the mini 3 battery connector (LDO then regulates).
- **mini 2:** different power design (KL26Z interface); not analysed here. Measure it.

### 8.4 Panic 050/051 at cold boot, and `CWAUTOCONN=0` [I]

**Observation** [M]:

- Cold plug-in with the C3 attached: panic 050/051 (accelerometer/compass not found) and strong flicker.
- After a flash (warm reset, ESP already running): never.

**Most plausible mechanism:** at a cold start the Calliope (CODAL probes the LSM303AGR early) and the ESP32-C3 power up together. The ESP's boot sequence contains:

1. inrush into the module's capacitors (small and short with the NCP114 limit)
2. PHY/RF calibration when the AT firmware starts Wi-Fi at boot (as long as the stored `CWMODE` ≠ 0)
3. with `CWAUTOCONN=1` and a stored AP: active scanning (probe requests at full power on every channel), association and DHCP within the first ~0.5-3 s

Bursts of up to ~350 mA against a 300-600 mA LDO with 4.7 µF output capacitance can pull `VCC` down or into a brown-out/reset loop of the ESP. The flicker fits that. The sensor then boots or gets probed during a dip and NACKs. On a warm reset the ESP is idle, so there are no bursts.

**What `AT+CWAUTOCONN=0` does:**

- It removes (3) and the repeated reconnect attempts. That is the longest and most frequent burst train.
- It does **not** remove (2): calibration still runs at Wi-Fi start. The peak magnitude is similar; the number and duration of peaks drop.

**What removes RF activity at boot completely (ESP-AT only):** persisting `AT+CWMODE=0` (Null mode, "Wi-Fi RF will be disabled") with `SYSSTORE=1`. The driver later turns Wi-Fi on with `SYSSTORE=0` / `AT+CWMODE=1,0` after the Calliope has initialised its sensors. ESP-AT 2.2.2.0 for ESP8266 even fixed "high power consumption after power-on when AT+CWMODE=0 was set", which shows this is an intended low-power state [V].

NonOS (Grove V2) offers neither: it always calibrates at boot. `CWAUTOCONN=0` and `CWMODE_DEF=1` (no soft-AP beacons) are the only levers [I].

**Tests** (add to the plan's §5 matrix):

1. Scope on the Grove VCC pin during 20 cold plug-ins each:
   - stock
   - `CWAUTOCONN=0`
   - persisted `CWMODE=0`
   - with an extra 220-470 µF low-ESR cap at the module
2. Log the AT port: count `ready` lines per cold start (> 1 means reset loop).
3. Same with USB vs LiPo vs 2×AAA.
4. Same with the Grove V2.

---

## 9. Open points to measure on our hardware

1. `AT+GMR` of our Grove V2: exact version, Seeed line present or not.
2. On the Grove V2: behaviour of `AT+CWJAP_CUR` failure (`FAIL` plus code), `No AP`, boot garbage length before `ready`, whether a soft-AP is active by default (`AT+CWMODE_DEF?`).
3. If 1.7.x: real `+CIPRECVDATA` separator (`:` vs `,`).
4. `AT+CIPRECVTYPE?` vs `AT+CIPRECVMODE?` on our C3 3.3.0.0 (both should answer).
5. Whether `AT+SYSSTORE=0` persists across `AT+RST` on the C3.
6. Cold-boot tests of §8.4.
7. Optional: `AT+CIUPDATE` on a spare Grove V2 (1.6 → 1.7 nano?).
8. Optional: ESP-AT 2.3 on a spare Grove V2 with TLS to `campus-api` (heap, handshake time).

---

## 10. Sources

Seeed / Grove UART WiFi V2
- Seeed wiki: https://wiki.seeedstudio.com/Grove-UART_Wifi_V2/ (markdown: https://github.com/SeeedDocument/wiki_english/blob/master/docs/Grove-UART_Wifi_V2.md)
- Wiki firmware image (AT 0.24, V1 layout): https://github.com/SeeedDocument/Grove-Uart_Wifi/raw/master/res/Grove-uart-wifi-firmware-bin.zip ; source: https://raw.githubusercontent.com/SeeedDocument/Grove-Uart_Wifi/master/res/Grove-Uart_Wifi_Firmware-code.zip
- V2 schematic: https://github.com/SeeedDocument/Grove-Uart_Wifi/raw/master/res/Grove%20-%20Uart%20Wifi%20v2%20sch.pdf
- Seeed forum thread: https://forum.seeedstudio.com/t/firmware-for-the-grove-uart-wifi-v2-with-esp8285/267564
- Carmine Noviello, "Upgrading Grove-UART WiFi V2 to latest ESP-AT firmware": https://www.carminenoviello.com/2022/12/17/upgrading-grove-uart-wifi-v2-to-latest-esp-at-firmware/
- Seeed MakeCode driver: https://github.com/Seeed-Studio/pxt-grove (local copy `%TEMP%\iot-ext-research\pxt-grove-upstream\main.ts`)

Espressif NonOS AT
- ESP8266 AT Instruction Set v3.0.2 (mirror): https://www.waveshare.com/w/upload/8/86/Esp8266_at_instruction_set_en.pdf ; v3.0.1: https://cdn.sparkfun.com/assets/5/1/e/e/5/Spec-16031.pdf ; v1.5.4: https://www.espressif.com/sites/default/files/4a-esp8266_at_instruction_set_en_v1.5.4_0.pdf
- ESP8266_NONOS_SDK releases (AT version history): https://github.com/espressif/ESP8266_NONOS_SDK/releases
- AT bin notes (normal vs nano): https://github.com/espressif/ESP8266_NONOS_SDK/blob/master/bin/at/README.md ; https://github.com/espressif/ESP8266_NONOS_SDK/tree/master/examples/at_nano
- Binaries scanned: `bin/at/512+512/user1.1024.new.2.bin` and `bin/at/1024+1024/user1.2048.new.5.bin` at `master` (1.7.6), and `bin/at/512+512/user1.1024.new.2.bin` at tags `v2.2.1` (1.6.2), `v2.2.0` (1.6.0), `v2.1.0` (1.4.0) of https://github.com/espressif/ESP8266_NONOS_SDK
- ESP8266 SSL User Manual v2.0 (archived): http://web.archive.org/web/2020/https://www.espressif.com/sites/default/files/documentation/5a-esp8266_sdk_ssl_user_manual_en.pdf
- Espressif forum, "1MB flash → only AT v1.6.2": https://bbs.espressif.com/viewtopic.php?t=55177 ; TLS 1.2 in NonOS: https://bbs.espressif.com/viewtopic.php?t=27182

Espressif ESP-AT
- Command set comparison NonOS vs ESP-AT: https://docs.espressif.com/projects/esp-at/en/release-v2.2.0.0_esp8266/AT_Command_Set/AT_Command_Set_Comparison.html
- ESP8266 ESP-AT docs: https://docs.espressif.com/projects/esp-at/en/release-v2.2.0.0_esp8266/ ; module differences: https://github.com/espressif/esp-at/blob/release/v2.2.0.0_esp8266/docs/en/Compile_and_Develop/How_to_understand_the_differences_of_each_type_of_module.md
- 1 MB module config: https://github.com/espressif/esp-at/tree/release/v2.2.0.0_esp8266/module_config/module_esp8266_1mb ; `main/Kconfig` and `components/customized_partitions/raw_data/factory_param/factory_param_data.csv` on the same branch
- ESP8266_RTOS_SDK mbedTLS defaults: https://github.com/espressif/ESP8266_RTOS_SDK/blob/v3.4/components/mbedtls/Kconfig
- ESP-AT releases (incl. v2.2.2.0_esp8266, v2.3.0.0_esp8266, v3.3.0.0): https://github.com/espressif/esp-at/releases
- ESP-AT current command docs (ESP32-C3): https://docs.espressif.com/projects/esp-at/en/latest/esp32c3/AT_Command_Set/index.html ; v3.3.0.0: https://docs.espressif.com/projects/esp-at/en/release-v3.3.0.0/esp32c3/index.html

Community
- sigmdel, "Installing the AT Firmware on an ESP-01S" (GMR strings 1.7.4/1.7.6/2.2.x, nano, 1 MB CI artifact): https://www.sigmdel.ca/michel/ha/esp8266/ESP01_AT_Firmware_en.html
- DCC-EX AT version notes: https://dcc-ex.com/support/wifi-at-version.html
- Sipeed ESP8285 firmware (ships `ESP8285-AT-V1.7.4_8Mbit_40Mhz.bin`): https://wiki.sipeed.com/soft/maixpy/en/get_started/upgrade_esp8285_firmware.html
- ESP8266 ROM baud 74880: http://cholla.mmto.org/esp8266/weird_baud/

Datasheets / hardware
- ESP8285 datasheet (2023, archived): http://web.archive.org/web/2024/https://www.espressif.com/sites/default/files/documentation/0a-esp8285_datasheet_en.pdf ; Seeed copy v1.3: https://github.com/SeeedDocument/Grove-Uart_Wifi/raw/master/res/ESP8285_datasheet.pdf
- ESP32-C3-MINI-1 datasheet v1.3 (archived): http://web.archive.org/web/2022/https://www.espressif.com/sites/default/files/documentation/esp32-c3-mini-1_datasheet_en.pdf
- ETA3410: https://files.seeedstudio.com/wiki/round_display_for_xiao/ETA3410-datasheet.pdf
- NCP114: https://www.onsemi.com/pub/Collateral/NCP114-D.PDF
- BAT60A: https://www.infineon.com/part/BAT60A
- Calliope docs, power supply: https://docs.calliope.cc/en/tech/hardware/stromversorgung/ ; components: https://docs.calliope.cc/tech/hardware/bauteile/ ; mini 3 schematic: https://docs.calliope.cc/tech/hardware/datenblatt/assets/calliope-mini-3-schaltplan.pdf

Own measurements
- ESP32-C3 findings: `calliope-campus/nimbalyst-local/plans/iot-extension-standalone.md` §1.1
- TLS probe of `campus-api.calliope.cc:443`, 2026-09-29, `openssl s_client` 3.1.2 (cipher-by-cipher, `-showcerts`, `-maxfraglen 2048 -tlsextdebug`, `-noservername`)
- ESP-AT 4.2 GMR on a C3: `%TEMP%\iot-ext-research\pxt-wifi@AP_mode\pythonTools\docs\claude-esp-at-ota-upgrade.md`
