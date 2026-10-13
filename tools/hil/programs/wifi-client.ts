// HIL check of the WLAN client (wlanclient.ts, namespace iotwifi) on a mini 3.
//
// Run:  python tools/hil/hil.py run programs/wifi-client.ts --variant v3 \
//           --start "=====WIFI=====" --end "=====END=====" --trace-timeout 180
// Placeholders from tools/hil/secret.json: $SSID $PW $REF (write token or
// reference of a test dashboard) $SERVER (LAN ingest base, http://…/api/iot/v1).
//
// The module has its own UART (UARTE1), so every line goes out over USB serial
// as it happens. Each step prints what it expects and PASS/FAIL; the whole
// log is repeated at the end between the markers, every 5 s.
let log = ""
let passed = 0
let failed = 0
function note(s: string) {
    log = log + s + "\n"
    serial.writeLine(s)
}
function check(name: string, ok: boolean, expect: string) {
    if (ok) passed++
    else failed++
    note((ok ? "PASS " : "FAIL ") + name + "  (expected " + expect + ")")
}
/** Printable: escapes CR/LF, shows bytes >= 0x80 as \xNN (strings are byte strings). */
function show(s: string): string {
    let out = ""
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c == 13) out += "\\r"
        else if (c == 10) out += "\\n"
        else if (c < 32 || c > 126) out += "\\x" + "0123456789abcdef".charAt(c >> 4) + "0123456789abcdef".charAt(c & 15)
        else out += s.charAt(i)
    }
    return out
}
function answer(label: string, a: iotcore.Answer, ms: number) {
    let rows = ""
    for (let i = 0; i < a.dFeeds.length && i < 6; i++) {
        rows += (i > 0 ? "; " : "") + show(a.dFeeds[i]) + "=" + show(a.dValues[i]) + " from " + a.dFroms[i] +
            (a.dTos[i].length > 0 ? " to " + a.dTos[i] : "")
    }
    note(label + ": ok=" + (a.ok ? 1 : 0) + " dup=" + (a.dup ? 1 : 0) + " error=" + (a.error.length > 0 ? a.error : "-") +
        " retryAfterMs=" + a.retryAfterMs + " ts=" + a.serverSec + " tzo=" + a.tzoMin + " cur=" + a.cur +
        " more=" + (a.more ? 1 : 0) + " rows=" + a.dFeeds.length + " (" + ms + " ms)")
    if (rows.length > 0) note("    rows: " + rows)
}
function status() {
    note("state=" + iotwifi.stateText() + " lastError=" + (iotwifi.lastError().length > 0 ? iotwifi.lastError() : "-") +
        " rssi=" + iotwifi.rssi() + " dBm")
}
function engine() {
    note("engine: passivePending=" + iotwlan.stats(0) + " resets=" + iotwlan.stats(1) + " busy=" + iotwlan.stats(2) +
        " stale=" + iotwlan.stats(3) + " lost=" + iotwlan.stats(4) + " ringStalls=" + iotwlan.stats(5) +
        " port=" + iotwlan.stats(6) + " (1 own UART, 2 redirect)")
}

/** Two points: a number with a label and a text with umlauts (escaped by jsonQuote). */
function makeBatch(seq: number, n: number): iotcore.Batch {
    const b = new iotcore.Batch()
    b.seq = seq
    b.feeds = ["hil_temp", "hil_text"]
    b.values = ["" + n, iotwifi.jsonQuote("Grüße " + n)]
    b.tos = ["", ""]
    b.ages = [1500, 200]
    b.labelKeys = ["hil_temp"]
    b.labelTexts = ["HIL Temp"]
    return b
}

let skipped = 0
/** Post, print the Answer and what the module returned for the LAST AT command of the exchange. */
function post(label: string, b: iotcore.Batch, ctx: iotcore.IngestContext): iotcore.Answer {
    const t = control.millis()
    const a = iotwifi.postIngest(b, ctx)
    answer(label, a, control.millis() - t)
    let lines = ""
    for (let i = 0; i < iotwlan.lineCount(); i++) lines += (i > 0 ? " | " : "") + show(iotwlan.line(i))
    const n = iotwlan.payloadLength()
    note("    last AT result: flags=" + iotwlan.resultFlags() + " (1 sent, 2 reset, 4 truncated) lines=[" + lines +
        "] payload " + n + " bytes" + (n > 0 ? ": " + show(iotwlan.payload(0, 100)) : ""))
    return a
}

basic.showNumber(0)
note("=====WIFI=====")
note("wifi-client HIL: connect, 2 LAN posts (cursor), 429 + retry + dup, TCP path, production 401 x2")
iotwifi.connect("$SSID", "$PW", SerialPin.C17, SerialPin.C16)
note("connect() returned at " + control.millis() + " ms, state=" + iotwifi.stateText() +
    " sender registered=" + (iotcore.wlanSender() ? 1 : 0))

basic.showNumber(1)
const t0 = control.millis()
const online = iotwifi.waitOnline(90000)
note("waitOnline -> " + online + " after " + (control.millis() - t0) + " ms (uptime " + control.millis() + ")")
note("module: family=" + iotwifi.moduleFamily() + " (2 ESP-AT, 1 AT 1.x) version=" + iotwifi.moduleVersion() +
    " chip=" + iotwifi.moduleChip() + " caps=" + iotwifi.capabilities() + " (1 http, 2 passive, 4 tls, 8 sysstore)" +
    " passive=" + iotwifi.passiveReceive())
status()
engine()
check("online", online, "ONLINE within 90 s")

const boot = "hil" + randint(100000, 999999)
const ctx = new iotcore.IngestContext()
ctx.ref = "$REF"
ctx.server = "$SERVER"
// `--var DEV=<id>` overrides the device id, e.g. when the real one is blocked
// on the test dashboard. "$DEV" stays literal when the variable is not given.
const devOverride = "$DEV"
ctx.dev = devOverride.charAt(0) == "$" ? "" + (control.deviceSerialNumber() >>> 0) : devOverride
ctx.scope = "a"
ctx.since = 0
ctx.boot = boot
note("ctx: server=" + ctx.server + " dev=" + ctx.dev + " boot=" + boot + " scope=a")

if (online) {
    basic.showNumber(2)
    note("--- 1: HTTPCPOST to the LAN server, since=0 (snapshot + start cursor)")
    const a1 = post("post1", makeBatch(1, 21), ctx)
    check("post1 ok", a1.ok && a1.cur >= 0, "ok=1 and cur >= 0")
    check("post1 clock", a1.serverSec > 1700000000, "ts = server unix time")

    basic.pause(1200) // server floor: one batch per device per 900 ms
    basic.showNumber(3)
    note("--- 2: HTTPCPOST again, since = cur of post1")
    ctx.since = a1.cur >= 0 ? a1.cur : 0
    const a2 = post("post2", makeBatch(2, 22), ctx)
    check("post2 ok", a2.ok && a2.cur >= ctx.since, "ok=1 and cur >= since")
    if (a2.cur >= 0) ctx.since = a2.cur

    basic.showNumber(4)
    note("--- 3: back-to-back posts (no pause) until the server refuses one with 429 too_fast (limit: 900 ms per device)")
    note("    this shows how AT+HTTPCPOST hands over a 4xx answer: see 'last AT result' below")
    let seq = 3
    let b3 = makeBatch(seq, 20 + seq)
    let a3 = post("post" + seq, b3, ctx)
    for (let i = 0; i < 2 && a3.ok; i++) {
        seq++
        b3 = makeBatch(seq, 20 + seq)
        a3 = post("post" + seq, b3, ctx)
    }
    if (a3.ok) {
        skipped++
        note("SKIP post 429  (every post took > 900 ms end to end, so the server never refused one; not a client error)")
    } else {
        check("post 429", a3.error == "too_fast" && a3.retryAfterMs > 0,
            "ok=0 error=too_fast retryAfterMs>0 from the 429 body")
        basic.pause(a3.retryAfterMs > 0 ? a3.retryAfterMs + 300 : 1300)
        const a3b = post("post" + seq + " retry", b3, ctx)
        check("retry after 429 ok", a3b.ok && !a3b.dup, "ok=1 dup=0 (the refused batch was not written)")
    }
    basic.pause(1200)
    const a3c = post("post" + seq + " replay", b3, ctx)
    check("replay dup", a3c.ok && a3c.dup, "ok=1 dup=1 (same boot + seq: the server drops the copy)")
    if (a3c.cur >= 0) ctx.since = a3c.cur

    basic.pause(1200)
    basic.showNumber(5)
    note("--- 4: same server over CIPSTART/CIPSEND (" + (iotwifi.passiveReceive() ? "passive CIPRECVDATA pulls" : "active +IPD") + ")")
    iotwifi.preferTcp(true)
    seq++
    const a4 = post("post" + seq + " tcp", makeBatch(seq, 20 + seq), ctx)
    check("tcp post ok", a4.ok && !a4.dup, "ok=1 dup=0 over the raw HTTP path")
    engine()

    basic.showNumber(6)
    note("--- 5: production over HTTPS with a dummy token: expect 401 bad_token")
    iotwifi.preferTcp(false)
    const prod = new iotcore.IngestContext()
    prod.ref = "W-HIL0-TEST-0000"
    prod.server = "https://campus-api.calliope.cc/api/iot/v1"
    prod.dev = ctx.dev
    prod.scope = "d"
    prod.since = 0
    prod.boot = boot
    // A 404 means TLS, the request and the answer framing all worked, but the
    // production PocketBase has no IoT routes deployed (yet): not a client error.
    const a5 = post("prod httpcpost", makeBatch(1, 1), prod)
    if (a5.error == "http-404") {
        skipped++
        note("SKIP prod httpcpost 401  (production answered 404 over HTTPS: IoT routes not deployed there; TLS + framing OK)")
    } else {
        check("prod httpcpost 401", !a5.ok && (a5.error == "bad_token" || a5.error == "http-401"),
            "error=bad_token (body) or http-401 (ERR CODE line)")
    }
    basic.pause(1200)
    iotwifi.preferTcp(true)
    const a6 = post("prod ssl", makeBatch(1, 1), prod)
    if (a6.error == "http-404") {
        skipped++
        note("SKIP prod ssl 401  (production answered 404 over CIPSTART \"SSL\": IoT routes not deployed there; TLS + status line OK)")
    } else {
        check("prod ssl 401", !a6.ok && a6.error == "bad_token", "error=bad_token (CIPSTART \"SSL\" + status line 401)")
    }
    iotwifi.preferTcp(false)
}

status()
engine()
if (!online) note("not online: see state/lastError above (wrong-password, ap-not-found, no-module = module not answering on C17/C16)")
note("RESULT " + passed + " passed, " + failed + " failed, " + skipped + " skipped")
note("=====END=====")
if (failed == 0) basic.showIcon(IconNames.Yes)
else basic.showIcon(IconNames.No)
basic.forever(function () {
    basic.pause(5000)
    serial.writeLine("=====WIFI=====")
    serial.writeString(log)
    serial.writeLine("=====END=====")
})
