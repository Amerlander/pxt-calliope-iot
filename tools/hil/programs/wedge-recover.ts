// HIL check: the WLAN client recovers a module that is stuck from before a
// reset of the Calliope, without a power cycle.
//
// The module keeps its power while the Calliope is reflashed. Phase 1 leaves
// it in the state a reset in the middle of a send leaves behind; phase 2 is a
// normal program that only calls iotwifi.connect(). Do NOT unplug in between.
//
//   1. python tools/hil/hil.py run programs/wedge-recover.ts --variant v3 --var PHASE=1 \
//          --start "=====WEDGE=====" --end "=====END====="
//      PHASE=1  CIPSEND=4000 to the LAN server, '>' seen, no data   (the observed case)
//      PHASE=1h HTTPCPOST with 4000 bytes announced, no data        (the client's normal path)
//      PHASE=1t transparent mode: CIPMODE=1 + CIPSEND                 (rung "+++")
//   2. python tools/hil/hil.py run programs/wedge-recover.ts --variant v3 --var PHASE=2 \
//          --start "=====WEDGE=====" --end "=====END=====" --trace-timeout 120
//      optional: --var DEV=-781 (device id for the test post, if the real one is blocked)
//
// Placeholders: $SSID $PW $REF $SERVER (LAN ingest base, http://<host>:<port>/api/iot/v1).
// The module has its own UART (UARTE1): everything is printed live over USB
// serial and repeated every 5 s between the markers.
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
function lines(): string {
    let out = ""
    for (let i = 0; i < iotwlan.lineCount(); i++) out += (i > 0 ? " | " : "") + iotwlan.line(i)
    return out
}
const CODES = ["OK", "ERROR", "FAIL", "TIMEOUT", "BUSY"]
function res(label: string, code: number) {
    note(label + " -> " + (code >= 0 && code < 5 ? CODES[code] : "" + code) + " flags=" + iotwlan.resultFlags() +
        " lines=[" + lines() + "]")
}

const phaseArg: string = "$PHASE"
const phase: string = phaseArg == "1" || phaseArg == "1h" || phaseArg == "1t" ? phaseArg : "2"
const server: string = "$SERVER"
// "http://192.168.1.172:8090/api/iot/v1" -> host, port
let hostPort = server.substr(server.indexOf("://") + 3)
if (hostPort.indexOf("/") >= 0) hostPort = hostPort.substr(0, hostPort.indexOf("/"))
let host = hostPort
let port = 80
if (hostPort.indexOf(":") >= 0) {
    host = hostPort.substr(0, hostPort.indexOf(":"))
    port = parseInt(hostPort.substr(hostPort.indexOf(":") + 1))
}
const WEDGE_LEN = 4000

basic.showString(phase == "2" ? "2" : "1")
note("=====WEDGE=====")

if (phase != "2") {
    // ---------------------------------------------------------------- phase 1
    note("phase " + phase + ": leave the module stuck the way a reset in the middle of a send does")
    note("begin=" + iotwlan.begin(SerialPin.C17, SerialPin.C16, 115200) + " (1 own UART) at " + control.millis() + " ms")
    const alive = iotwlan.wake(10, 500)
    note("wake=" + alive + " echoOff=" + iotwlan.echoOff(1000))
    if (!alive) note("the module does not answer even now: unplug USB for 10 s, then run phase 1 again")
    res("CIPCLOSE", iotwlan.command("AT+CIPCLOSE", 2000))
    res("CIPMODE=0", iotwlan.command("AT+CIPMODE=0", 1000))
    res("CWSTATE?", iotwlan.command("AT+CWSTATE?", 2000))
    if (iotwlan.findLine("+CWSTATE:2").length == 0) {
        res("CWJAP", iotwlan.command("AT+CWJAP=\"" + iotwifi.atEscape(iotwifi.toUtf8("$SSID")) + "\",\"" +
            iotwifi.atEscape(iotwifi.toUtf8("$PW")) + "\"", 20000))
    }
    let r = -1
    if (phase == "1h") {
        note("HTTPCPOST to " + server + "/ingest announcing " + WEDGE_LEN + " bytes, then sending none")
        r = iotwlan.sendData("AT+HTTPCPOST=\"" + server + "/ingest\"," + WEDGE_LEN + ",1,\"Content-Type: application/json\"", "", 3000)
    } else {
        if (phase == "1t") res("CIPMODE=1", iotwlan.command("AT+CIPMODE=1", 1000))
        res("CIPSTART " + host + ":" + port, iotwlan.command("AT+CIPSTART=\"TCP\",\"" + host + "\"," + port, 10000))
        if (phase == "1t") {
            note("CIPSEND without length: transparent mode, every byte goes to the server")
            r = iotwlan.sendData("AT+CIPSEND", "", 3000)
        } else {
            note("CIPSEND=" + WEDGE_LEN + ", then no data")
            r = iotwlan.sendData("AT+CIPSEND=" + WEDGE_LEN, "", 3000)
        }
    }
    note("send -> " + (r >= 0 && r < 5 ? CODES[r] : "" + r) + " flags=" + iotwlan.resultFlags() +
        " (expected TIMEOUT with flag 1: '>' seen, no data written)")
    check("prompt seen", (iotwlan.resultFlags() & 1) != 0, "the module showed '>' and now waits for data")
    const probe = iotwlan.command("AT", 1000)
    check("module deaf now", probe == 3, "AT -> TIMEOUT: it is swallowed as payload (" + CODES[probe] + ")")
    note("WEDGED. Now reflash phase 2 WITHOUT unplugging:")
    note("  python tools/hil/hil.py run programs/wedge-recover.ts --variant v3 --var PHASE=2 --start \"=====WEDGE=====\" --end \"=====END=====\" --trace-timeout 120")
} else {
    // ---------------------------------------------------------------- phase 2
    note("phase 2: a normal program calls iotwifi.connect(); the client must bring a stuck module back")
    const t0 = control.millis()
    iotwifi.connect("$SSID", "$PW", SerialPin.C17, SerialPin.C16)
    const online = iotwifi.waitOnline(60000)
    note("waitOnline -> " + online + " after " + (control.millis() - t0) + " ms (uptime " + control.millis() + ")")
    note("recovery: rung=" + (iotwifi.recoveryRung().length > 0 ? iotwifi.recoveryRung() : "(not needed)") +
        " runs=" + iotwifi.recoveryRuns() + " ladder=" + iotwifi.recoveryMs() + " ms bytesHeard=" + iotwifi.recoveryBytes())
    note("  rungs: filler = a cut-off send completed with CRLF; +++ = left transparent mode; reset = AT+RST; none = gave up")
    note("state=" + iotwifi.stateText() + " lastError=" + (iotwifi.lastError().length > 0 ? iotwifi.lastError() : "-") +
        " rssi=" + iotwifi.rssi() + " module=" + iotwifi.moduleChip() + " " + iotwifi.moduleVersion())
    note("engine: resets=" + iotwlan.stats(1) + " busy=" + iotwlan.stats(2) + " stale=" + iotwlan.stats(3) +
        " lost=" + iotwlan.stats(4) + " rxBytes=" + iotwlan.stats(9))
    check("online without a power cycle", online, "ONLINE within 60 s")
    const rung = iotwifi.recoveryRung()
    if (rung == "") {
        note("SKIP recovery  (the module answered at once: the stuck state did not survive the reflash, or phase 1 did not leave it stuck)")
    } else {
        check("recovered by a rung", rung == "filler" || rung == "+++" || rung == "reset",
            "filler (PHASE=1/1h), +++ (PHASE=1t) or reset")
    }
    if (online) {
        const devArg: string = "$DEV"
        const ctx = new iotcore.IngestContext()
        ctx.ref = "$REF"
        ctx.server = server
        ctx.dev = devArg.charAt(0) == "$" ? "" + (control.deviceSerialNumber() >>> 0) : devArg
        ctx.boot = "wedge" + randint(1000, 9999)
        const b = new iotcore.Batch()
        b.seq = 1
        b.feeds = ["hil_wedge"]
        b.values = ["1"]
        b.tos = [""]
        b.ages = [0]
        const a = iotwifi.postIngest(b, ctx)
        note("post: ok=" + (a.ok ? 1 : 0) + " error=" + (a.error.length > 0 ? a.error : "-") + " cur=" + a.cur)
        check("post after recovery", a.ok, "ok=1: the module is fully usable again")
    }
}

note("RESULT " + passed + " passed, " + failed + " failed")
note("=====END=====")
if (failed == 0) basic.showIcon(IconNames.Yes)
else basic.showIcon(IconNames.No)
basic.forever(function () {
    basic.pause(5000)
    serial.writeLine("=====WEDGE=====")
    serial.writeString(log)
    serial.writeLine("=====END=====")
})
