# Interfaces between the parts of the extension

Status 2026-10-08. Target: **Calliope mini 3** (WLAN). mini 1/2 compile with stubs and report "not supported"
for WLAN (plan E1, revised). Plan: `calliope-campus/nimbalyst-local/plans/iot-extension-standalone.md`.

## Files and owners

| File | Content | Owner |
|---|---|---|
| `wlanat.h`, `wlanat.cpp`, `wlanport.cpp`, `wlanshims.ts` | C++ AT engine + port, shims `iotwlan.*` (done, HIL-verified) | — |
| `iottypes.ts` | `iotcore.Batch`, `iotcore.Answer`, `BATCH_MAX` — the core ↔ WLAN contract | lead |
| `wlanclient.ts` | namespace `iotwifi`: module bring-up, join/rejoin, HTTP POST, ingest request/response | worker A |
| `iotcore.ts` | namespace `iotcore`: send buffer, flush loop, cache, handler dispatch, scope, identity, clock | worker B |
| `iotcampus.ts`, `iotdap.ts`, `iotdap.cpp` | Campus line protocol `IOT1:` over USB serial + RAM mailbox (mini 3), BLE side channel hooks | worker B |
| `iotsim.ts` | simulator path (`control.simmessages`, panel launch) | worker B |
| `iot.ts` (later, P4) | the blocks, namespace `iot` | — |

`wlanat.ts` / `wlanport.ts` stay in the repo as the TS reference of the C++ engine (Node-tested); they are not
in `pxt.json`.

## Core ↔ WLAN (worker A ↔ worker B)

```
iotcore  ──Batch──▶  iotwifi.postIngest(batch, ctx) : Answer   (blocking; called only from the WLAN worker fiber)
```

`ctx` carries what the request needs besides the points: reference (`t`), server base URL, device id (`dev`),
read scope (`scope`), cursor (`since`), boot id (`boot`). Worker A defines it as a small class in
`wlanclient.ts` (`iotwifi.IngestContext`); the core fills it.

Rules the core relies on:
- `postIngest` never touches the core's buffers; it reads the Batch and returns an Answer.
- `ok` only for `"ok":1` (incl. `dup`). On !ok the core keeps the points and backs off (`retryAfterMs` wins).
- Downlink rows are returned in server order; the core advances the cursor only after dispatching them.
- `iotwifi.isOnline()` / `iotwifi.state()` for status blocks; joining and rejoining are the client's job.

## Core ↔ Campus / simulator (worker B internal)

Line protocol `IOT1:` as specified by Campus `src/lib/services/iot/wire.ts` (see the contract review in
the plan §1.4 and `pxt-grove/iot.ts` today). The core emits every uplink line to every open pipe
(mailbox, serial when the UART is not the module's, BLE side channel, simulator) and accepts downlink lines
from all of them; Campus de-duplicates.

## Campus-generated files the extension must keep working with

- ~~`iotfeeds.ts`~~ — **dropped (D5).** The extension defines `iot_feed_name` itself (`iot._feedField`, an
  "autocomplete" text field, TD_ID). Campus must no longer generate a block with that id: pxt keeps one
  definition per block id, and toolbox/decompiler (`blocksById`, last wins) and Blockly (first registered
  wins) would pick different ones. The dashboard's feeds reach the field's list by message (below).

## Feed suggestions: `calliope-iot-feeds` (editor window message)

The feed field (`iot_feed_name`, autocomplete key `iotfeed`) lists the feed names the program uses. The
dashboard's feeds come from whoever knows them, as a `postMessage` to the **editor window**:

```js
editorWindow.postMessage({ type: "calliope-iot-feeds", feeds: ["temp", "licht"] }, "*")
```

- Receiver: pxt-calliope `fieldeditors/iotFeedOptions.ts` (extends `FieldAutoComplete.getOptions` for the
  key `iotfeed` only; an editor without it shows the plain autocomplete). One list per sender; a message
  replaces only its sender's list, an empty one removes it; the field offers the union, and a sender whose
  frame is gone drops out. Names must match `^[a-z0-9_-]{1,40}$`, at most 200. Accepted only from the
  embedding page or from a frame inside the editor.
- Senders: the IoT simulator panel (pxt-iot-sim `sendFeedsToEditor`: after each `/read` view whose feed set
  changed, keys of `view.feeds` — only feeds that carry values), and Campus (`MakeCode.svelte`: every feed of
  the dashboard, on open, on change, from the chip's "Feeds" button; an empty list when the program closes).
  Checked live without Campus: the panel's list (`Licht`, `mic`, `temperatur`, `tmp`) showed up in the field
  next to the program's own `temp`.
- Nothing is written into the project: no `iotfeeds.ts`, no re-import.
- Checked live in the local editor: `tools/editor/feedoptions.mjs` (before: program feeds only; after the
  message: program feeds + dashboard feeds, invalid name dropped).
- `iotble.ts`: calls `iot.setzeZusatzKanal(fn)` and `iot.empfangeVonAussen(line)` — names may change with P5,
  until then the core exposes them (worker B).
