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

// Focused check of the raw TLS path to production (CIPSTART "SSL"), which timed
// out once on 2026-10-13 after answering in 1.3 s on the run before.
// Run: hil.py run programs/ssl-prod.ts --variant v3 --var DEV=-781 --start "=====SSL=====" --end "=====END=====" --trace-timeout 300
note("=====SSL=====")
iotwifi.connect("$SSID", "$PW", SerialPin.C17, SerialPin.C16)
note("online=" + iotwifi.waitOnline(90000))
const devOverride = "$DEV"
const prod = new iotcore.IngestContext()
prod.ref = "W-HIL0-TEST-0000"
prod.server = "https://campus-api.calliope.cc/api/iot/v1"
prod.dev = devOverride.charAt(0) == "$" ? "" + (control.deviceSerialNumber() >>> 0) : devOverride
prod.scope = "d"
prod.since = 0
prod.boot = "ssl" + randint(1000, 9999)
let timeouts = 0
let answered = 0
for (let round = 1; round <= 3; round++) {
    iotwifi.preferTcp(true)
    const a = post("raw ssl #" + round, makeBatch(round, round), prod)
    if (a.error == "timeout") timeouts++
    else answered++
    engine()
    status()
    basic.pause(1500)
    iotwifi.preferTcp(false)
    const b = post("httpcpost #" + round, makeBatch(round, round), prod)
    if (b.error == "timeout") timeouts++
    else answered++
    basic.pause(1500)
}
note("RESULT answered=" + answered + " timeouts=" + timeouts)
note("=====END=====")
basic.forever(function () {
    serial.writeLine("=====SUMMARY=====")
    serial.writeLine(log)
    serial.writeLine("=====SUMEND=====")
    basic.pause(5000)
})
