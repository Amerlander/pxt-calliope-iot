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
| `iot_wifi_connect` | `iot.connectWifi(ssid, password, tx?, rx?)` | `connect to WiFi $ssid password $password \|\| TX $tx RX $rx` | `mit WLAN $ssid Passwort $password verbinden \|\| TX $tx RX $rx` | Non-blocking. Opens the module UART after the 5 s cold-boot rule. Pins default C17/C16 (Grove A1), hidden behind "+". Its presence switches the program to WLAN. Campus fills ssid/password from the room settings (only into a completely empty block). |
| `iot_dashboard` | `iot.connectDashboard(reference, server?)` | `connect to dashboard $reference \|\| server $server` | `mit Dashboard $reference verbinden \|\| Server $server` | Campus writes reference and server only when a dashboard is picked in the chip. Default server: `https://campus-api.calliope.cc`. |
| `iot_interval` | `iot.setInterval(interval: IotInterval)` | `send every $interval` | `sende $interval` | Required parameter. `IotInterval`: immediately / every second / every 5 seconds / every minute / every hour (de: sofort / jede Sekunde / alle 5 Sekunden / jede Minute / jede Stunde). WLAN floor 1 s. **Hidden since v0.1.2**: without it values go at once (D3). |

## Sending

| id | TS | en | de | notes |
|---|---|---|---|---|
| `iot_send` | `iot.send(feed, value, to?)` | `send $feed = $value \|\| to $to` | `sende $feed = $value \|\| an $to` | Queued, sent in the interval. `to`: shadow `iot_target` (all / dashboard) or a device id. The same feed to the same receiver at most every 250 ms: called sooner, the block waits for the rest (a forever loop without a pause otherwise queued ~50 values/s while ~8/s leave over WiFi). Different feeds never wait for each other. Same rule for `send text`. |
| `iot_send_text` | `iot.sendText(feed, text, to?)` | `send text $feed = $text \|\| to $to` | `sende Text $feed = $text \|\| an $to` | Text capped at 160 bytes. |
| `iot_send_now` | `iot.sendNow()` | `send now` | `sende jetzt` | Flush without waiting for the interval (still ≥ 1 s on WLAN). **Hidden since v0.1.2** (D3). |
| `iot_on_sent` | `iot.onSent(feed, handler(feed, value, to))` | `on $feed sent` | `wenn $feed gesendet` | Fires only after the server confirmed. Empty feed = every feed (the feed field starts empty). |

## Receiving

| id | TS | en | de | notes |
|---|---|---|---|---|
| `iot_on_number` | `iot.onNumber(feed, from, handler(value, from, to))` | `on $feed received from $from` | `wenn $feed von $from empfangen` | Draggable `value`, `from`, `to`. `from`: shadow `iot_who`. Own values count ("all" includes me). Fires only for values to everyone or to this device. |
| `iot_on_text` | `iot.onText(feed, from, handler(text, from, to))` | `on text $feed received from $from` | `wenn Text $feed von $from empfangen` | as above |
| `iot_read` | `iot.read(feed, from?, to?)` | `read $feed \|\| from $from to $to` | `lese $feed \|\| von $from an $to` | From the local cache, never the network. Addressee semantics: see D4. |
| `iot_read_text` | `iot.readText(feed, from?, to?)` | `read text $feed \|\| from $from to $to` | `lese Text $feed \|\| von $from an $to` | |
| `iot_who` (hidden) | `iot.who(w: IotWho)` | `$w` | | all / dashboard / other devices / all but me / only this device |
| `iot_target` (hidden) | `iot.target(t: IotTarget)` | `$t` | | all / dashboard |

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

Advanced (`//% advanced=true`): module firmware version, module info.

## Campus coupling (P5 checklist input)

- Dependency key `iot`, repo `Amerlander/pxt-calliope-iot` for now (simx key `amerlander/pxt-calliope-iot`), later `calliope-edu/pxt-calliope-iot`: when it moves, change `iotsim.panelKey()`, the targetconfig key and the Campus pin together.
- Program is IoT ⇔ `main.ts` calls any `iot.` function from this list.
- Path is WLAN ⇔ `iot.connectWifi(` is present (E9).
- `iot.connectDashboard("<ref>"[, "<server>"])`: ref first, server second (literals).
- `iot.connectWifi("<ssid>", "<password>"…)`: ssid first, password second.
- Blocks XML: `iot_dashboard` inputs `reference`, `server`; `iot_wifi_connect` inputs `ssid`, `password`,
  fields `tx`, `rx`.
- `iotfeeds.ts` is no longer generated for programs with this extension (D5); a block with id
  `iot_feed_name` in a project file would collide with the extension's own.
- Feed names in code are plain literals: `iot.send("temp", 5)` (the shadow compiles to the bare text).
- `iotble.ts` keeps working (`iot.setzeZusatzKanal`, `iot.empfangeVonAussen` — may be renamed in P5
  together with Campus).

## Decisions (2026-10-13)

- **D3 — no interval block (changed in v0.1.2, was: default 5 s).** Every value goes as soon as it may: over
  WiFi at most one request per second (counted from the previous answer), through Campus at once (the relay
  batches once per second). With nothing to send, a program that reads or still needs the clock asks every
  2 s, so a dashboard value reaches the mini within ~2 s. The buffer keeps values against loss, not back on
  purpose. `iot_interval` and `iot_send_now` are hidden (still in the API; programs containing them open).
  In the simulator values wait in the buffer until a dashboard is named — the panel does not exist before.
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
