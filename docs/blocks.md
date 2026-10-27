# Block catalogue (draft for review, 2026-10-13)

Namespace `iot` (TS: `iot.*`), English block ids and function names, English base texts, German translation
in `_locales/de/iot-strings.json`. Decisions this rests on: plan E4 (no compatibility with the old blocks),
E5 (en + de), E9 (no transport block — WLAN when the WiFi block is in the program, otherwise Campus).

Shadows: every feed input carries `feed.shadow="iot_feed_name"` — a text field whose list offers the feed
names already used in the program (pxt "autocomplete", like the datalogger's column field), defined by the
extension itself (D5). A child can drop a text block or a variable on it. Who/target inputs carry
hidden shadow blocks (`iot_who`, `iot_target`) with dropdowns; a child can drop a text or variable (device id)
on them instead.

## Connection

| id | TS | en | de | notes |
|---|---|---|---|---|
| `iot_connect` | `iot.connect(ssid, password, token, server?, tx?, rx?)` | `connect\|WiFi SSID $ssid\|password $password\|IoT token $token\|\|server $server\|TX $tx\|RX $rx` | `verbinde\|WLAN SSID $ssid\|Passwort $password\|IoT Token $token\|\|Server $server\|TX $tx\|RX $rx` | Since v0.3.0 the one connection block: one row per input (`inlineInputMode=external`), server and pins behind "+". Sets the dashboard (token = reference: slug or token, empty = Campus picks), then, with a non-empty SSID, starts WiFi and **waits** until the module is in the network: WiFi symbol building up on the LEDs, then a check mark (online) or a cross (`wrong-password`, `ap-not-found`, `no-module`, `uart-*`, mini 1/2, or 30 s passed), shown for 1 s, then the screen is cleared. The module keeps trying after a timeout. Empty SSID: Campus path, no waiting, no animation. The simulator plays one round of the animation and the check mark. |
| `iot_wifi_connect` | `iot.connectWifi(ssid, password, tx?, rx?)` | `connect to WiFi $ssid password $password \|\| TX $tx RX $rx` | `mit WLAN $ssid Passwort $password verbinden \|\| TX $tx RX $rx` | **Hidden since v0.3.0** (kept so old programs open as blocks; `iot_connect` replaces both). Non-blocking. Opens the module UART after the 5 s cold-boot rule. Pins default C17/C16 (Grove A1), hidden behind "+". Its presence switches the program to WLAN. Campus fills ssid/password from the room settings (only into a completely empty block). |
| `iot_dashboard` | `iot.connectDashboard(reference, server?)` | `connect to dashboard $reference \|\| server $server` | `mit Dashboard $reference verbinden \|\| Server $server` | **Hidden since v0.3.0.** Campus writes reference and server only when a dashboard is picked in the chip. Default server: `https://campus-api.calliope.cc`. |
| `iot_sync` | `iot.syncEvery(interval: IotSync, mode?: IotSyncMode)` | `sync with dashboard every $interval \|\| $mode` | `mit Dashboard abgleichen $interval \|\| $mode` | WLAN only. In "more" (`advanced=true`) since v0.3.0. At most one request per interval (it carries the collected values and brings the dashboard's new values back). `IotSync`: 2 s / 5 s / 10 s / minute / 10 minutes / hour (de labels carry the article: alle 2 Sekunden … jede Minute … jede Stunde). Without the block: 2 s. `IotSyncMode` behind "+": send and receive (default) / only send (no requests that only ask). From a minute on the module sleeps between syncs. See D3. |
| `iot_sleep` | `iot.sleepWifi()` | `put WiFi module to sleep` | `WLAN-Modul schlafen legen` | In "more" since v0.3.0. Radio off (AT+CWQAP, AT+CWMODE=0); the module stays reachable on its UART. The next value wakes it (radio on, join: a few seconds) and goes; until then no request goes out just to ask. Status `sleeping`. No deep sleep: waking from it early needs the module's reset line, which the Grove cable does not carry. |

## Sending

| id | TS | en | de | notes |
|---|---|---|---|---|
| `iot_send` | `iot.send(feed, value, to?)` | `send number $value to feed $feed` | `sende Zahl $value an Feed $feed` | Queued, sent in the interval. No receiver in the block since v0.3.0 (a value from blocks goes to everyone); `to` stays in code (`iot.target(IotTarget…)` or a device id). The same feed to the same receiver at most once per second: called sooner, the block waits for the rest (a forever loop without a pause otherwise queued ~50 values/s, each a row on the server). Different feeds never wait for each other. Same rule for `send text`. |
| `iot_send_text` | `iot.sendText(feed, text, to?)` | `send text $text to feed $feed` | `sende Text $text an Feed $feed` | Text capped at 160 bytes. |
| `iot_send_now` | `iot.sendNow()` | `send now` | `sende jetzt` | Flush without waiting for the interval (still ≥ 1 s on WLAN). **Hidden since v0.1.2** (D3). |
| `iot_on_sent` | `iot.onSent(feed, handler(feed, value))` | `on $feed sent` | `wenn $feed gesendet` | In "more" (`advanced=true`) since v0.3.0, and without the `to` parameter (the send blocks have no receiver). Fires only after the server confirmed. Empty feed = every feed (the feed field starts empty). |

## Receiving

| id | TS | en | de | notes |
|---|---|---|---|---|
| `iot_on_received` | `iot.onReceived(feed, handler(value))` | `on $feed received` | `wenn $feed empfangen` | Since v0.3.0: every sender, the handler gets only the value. Own values count. Fires only for values to everyone or to this device. |
| `iot_on_text_received` | `iot.onTextReceived(feed, handler(text))` | `on text $feed received` | `wenn Text $feed empfangen` | as above |
| `iot_on_number` | `iot.onNumber(feed, from, handler(value, from))` | `on $feed received from $from` | `wenn $feed von $from empfangen` | Under "more" since v0.3.0, without the `to` parameter. `from`: shadow `iot_who`. A "+" for the filter does not work: pxt puts the handler last in the generated call, so the filter cannot be optional. |
| `iot_on_text` | `iot.onText(feed, from, handler(text, from))` | `on text $feed received from $from` | `wenn Text $feed von $from empfangen` | as above |
| `iot_read` | `iot.read(feed, from?, to?)` | `read $feed \|\| from $from to $to` | `lese $feed \|\| von $from an $to` | From the local cache, never the network. Addressee semantics: see D4. |
| `iot_read_text` | `iot.readText(feed, from?, to?)` | `read text $feed \|\| from $from to $to` | `lese Text $feed \|\| von $from an $to` | |
| `iot_who` (hidden) | `iot.who(w: IotWho)` | `$w` | | all / dashboard / other devices / all but me / only this device |
| `iot_target` (hidden) | `iot.target(t: IotTarget)` | `$t` | | all / dashboard; for `to` in code only since v0.3.0 |

## Time

| id | TS | en | de |
|---|---|---|---|
| `iot_time_known` | `iot.timeKnown()` | `time known?` | `Zeit bekannt?` |
| `iot_time` | `iot.time()` | `time` | `Uhrzeit` (`HH:MM`, `--:--` until known) |
| `iot_hour` / `iot_minute` / `iot_second` | `iot.hour()` … | `hour` … | `Stunde` / `Minute` / `Sekunde` |
| `iot_date` | `iot.date()` | `date` | `Datum` |
| `iot_timestamp` | `iot.timestamp()` | `unix time` | `Unix-Zeit` |

## Diagnosis

| id | TS | en | de | notes |
|---|---|---|---|---|
| `iot_status` | `iot.status(): IotStatus` | `IoT status` | `IoT-Status` | not connected / connected / sending / error / no WiFi module |
| `iot_status_value` | `iot.statusValue(s)` | `$s` | | for comparisons |
| `iot_wifi_connected` | `iot.wifiConnected()` | `WiFi connected?` | `WLAN verbunden?` | |
| `iot_wifi_signal` | `iot.wifiSignal()` | `WiFi signal` | `WLAN-Signal` | RSSI in dBm |
| `iot_last_error` | `iot.lastError()` | `last error` | `letzter Fehler` | readable German/English text, e.g. "falsches WLAN-Passwort", "WLAN-Modul antwortet nicht – kurz vom Strom trennen" |
| `iot_device_id` | `iot.deviceName()` | `my device name` | `mein Gerätename` | friendly 5-letter name (display only) |
| `iot_log` | `iot.log(text)` | `log $text` | `protokolliere $text` | on every open pipe |

Since v0.3.0 all diagnosis blocks are under "more" (`//% advanced=true`); `log`, module firmware version and module info are hidden (callable from code only).

## Campus coupling (P5 checklist input)

- Dependency key `iot`, repo `Amerlander/pxt-calliope-iot` for now (simx key `amerlander/pxt-calliope-iot`), later `calliope-edu/pxt-calliope-iot`: when it moves, change `iotsim.panelKey()`, the targetconfig key and the Campus pin together.
- Program is IoT ⇔ `main.ts` calls any `iot.` function from this list.
- Since v0.3.0 the toolbox has one connection block, `iot.connect("<ssid>", "<password>", "<token>"[, "<server>"…])`:
  ssid, password, token (the reference), server, in that order. Path is WLAN ⇔ its ssid is not empty.
  Blocks XML: `iot_connect` inputs `ssid`, `password`, `token`, `server`, fields `tx`, `rx`.
- The v0.2 pair stays as hidden blocks, so programs that use it still work and open:
  path is WLAN ⇔ `iot.connectWifi(` is present (E9); `iot.connectDashboard("<ref>"[, "<server>"])`: ref
  first, server second (literals); `iot.connectWifi("<ssid>", "<password>"…)`: ssid first, password second.
  Blocks XML: `iot_dashboard` inputs `reference`, `server`; `iot_wifi_connect` inputs `ssid`, `password`,
  fields `tx`, `rx`.
- `iotfeeds.ts` is no longer generated for programs with this extension (D5); a block with id
  `iot_feed_name` in a project file would collide with the extension's own.
- Feed names in code are plain literals: `iot.send("temp", 5)` (the shadow compiles to the bare text).
- `iotble.ts` keeps working (`iot.setzeZusatzKanal`, `iot.empfangeVonAussen` — may be renamed in P5
  together with Campus).

## Decisions (2026-10-13)

- **D3 — sync interval (v0.2.0; was a fixed 5 s until v0.1.1, collecting windows in v0.1.2/v0.1.3).** One
  setting bounds how often a mini talks to the server over WiFi: at most one request per sync interval (2 s by
  default, `iot_sync` changes it). A value after a quiet spell goes at once — that costs no extra request; values
  that come sooner are collected until the next sync, or go at the 1 s floor once 8 (a full request) are there.
  A program that receives also asks every interval when it has nothing to send, unless set to "only send" or
  put to sleep. Requests per dashboard are therefore bounded by minis / interval (30 minis at 2 s: ≤ 15/s,
  below the server's guard of 30). From a minute on the module's radio goes off after each sync (wake: radio
  on + join, a few seconds). Through Campus every value goes at once (the relay batches). `iot_send_now`
  stays hidden. In the simulator values wait until a dashboard is named.
- **D4 — `read` without an addressee returns only values to everyone or to this device** (the handlers' rule);
  with an explicit `to` it returns exactly that addressee.
- **D5 — plain MakeCode without Campus (resolved 2026-10-13).** A shadow id without a block is not a cosmetic
  gap: the toolbox and the decompiler both emit `<shadow type="iot_feed_name">`, and pxt refuses to open
  such XML as blocks (`validateAllReferencedBlocksExist`, `webapp/src/monaco.tsx`) — the "program opens as
  JavaScript" symptom. A fallback in the extension that Campus overrides with the same id does not work
  either: `blocksById` keeps the last definition, `Blockly.Blocks` the first (`pxtblocks/loader.ts`).
  So the extension owns `iot_feed_name` as an "autocomplete" text field (`iot._feedField`, TD_ID,
  `decompileLiterals`, key `iotfeed`). Literals decompile into the field; the list shows the feed names the
  program already uses, so a feed the dashboard dropped stays offered as long as the program names it.
  Checked in the local editor (`tools/editor/blockscheck.mjs`, extension as a `file:` dependency, no Campus
  file): 22 blocks, literals and a variable in feed inputs, `on "" sent`; back to JavaScript gives
  `iot.send("temp", input.temperature())`. Control without the block: `Invalid block definition for type:
  iot_feed_name`, empty canvas.
  **The dashboard's feeds in that list:** upstream pxt has no way for a project file to add options to an
  extension's field, so pxt-calliope (not pxt) extends the autocomplete for the key `iotfeed` with names
  posted to the editor window — by the simulator panel or by Campus (`interfaces.md`, message
  `calliope-iot-feeds`). That also removes the `iotfeeds.ts` project rewrites and the re-imports they caused.
- Block texts as drafted above (approved unchanged).
