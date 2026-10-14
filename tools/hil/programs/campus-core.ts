// HIL program: the IoT core on the CAMPUS path (no WiFi block, so no WLAN sender).
//
// Build:  hil.py build tools/hil/programs/campus-core.ts --variant v3
// Trace:  hil.py trace --start CAMPUS-CORE-START --end CAMPUS-CORE-END --timeout 40
//
// Everything this program prints goes through the core itself (`iotcore.log`,
// i.e. `IOT1:l:` lines on USB serial + mailbox + BLE), never through its own
// `serial.writeString`: two fibers writing serial at once silently drop text in
// CODAL (`send` returns IN_USE), and the core writes protocol lines all the time.
//
// What to expect on USB serial, in order:
//   IOT1:r:a / IOT1:i:<serial> / IOT1:s:<server> / IOT1:h:<ref>   the hello (s/h only with a $REF)
//   IOT1:l:CAMPUS-CORE-START …                                    start marker + legend
//   IOT1:l:PASS|FAIL <check> (…)                                  local self-checks, no host needed
//   IOT1:n:temperatur:Temperatur                                  the typed spelling, once per host
//   IOT1:d::temperatur:<v> …                                      datapoints, interval 2 s
//   IOT1:l:CAMPUS-CORE-END checks=<n> fails=<m>                   end marker
//   then every 5 s: values + IOT1:l:status … clock=…              keeps running for a Campus test
//
// With Campus connected (USB, mini 3): the dashboard named by $REF gets
// `temperatur`, `zaehler`, `burst`; a dashboard value `sollwert` or a text
// `nachricht` shows up as `IOT1:l:RECV …`, and the clock line turns from --:--
// into the real time once Campus sends `IOT1:t:`.

let checks = 0
let fails = 0
let echoAll = 0
let echoButMe = 0
let sollCount = 0
let sollLast = -1
let sollFrom = ""
let sentCount = 0

function say(s: string) {
    iotcore.log(s)
}

function check(name: string, ok: boolean, detail: string) {
    checks++
    if (!ok) fails++
    say((ok ? "PASS " : "FAIL ") + name + (detail != "" ? " (" + detail + ")" : ""))
}

function two(n: number): string {
    return n < 10 ? "0" + n : "" + n
}

function clockText(): string {
    if (!iotcore.timeKnown()) return "--:--:--"
    const s = iotcore.localSeconds()
    return two(Math.floor(s / 3600) % 24) + ":" + two(Math.floor(s / 60) % 60) + ":" + two(s % 60)
}

function stateText(): string {
    const s = iotcore.status()
    if (s == iotcore.STATE_CONNECTED) return "connected"
    if (s == iotcore.STATE_SENDING) return "sending"
    if (s == iotcore.STATE_ERROR) return "error:" + iotcore.lastError()
    return "disconnected"
}

basic.showString("C")
iotcore.setDashboard("$REF", "$SERVER")
iotcore.setSync(2000)

say("CAMPUS-CORE-START id=" + iotcore.deviceId() + " name=" + iotcore.deviceName()
    + " server=" + iotcore.serverAddress())
say("legend: IOT1:l = this log, IOT1:d:<to>:<feed>:<value> = datapoint, IOT1:r/i/s/h = hello, IOT1:n = feed spelling")
say("downlink test: send IOT1:v:0::sollwert:7 or IOT1:t:<unix seconds> over serial, or set sollwert on the dashboard")

// ---- handlers ------------------------------------------------------------

iotcore.onNumber("echo", iotcore.WHO_ALL, function (v: number, from: string, to: string) {
    echoAll++
})
iotcore.onNumber("echo", iotcore.WHO_ALL_BUT_ME, function (v: number, from: string, to: string) {
    echoButMe++
})
iotcore.onNumber("Sollwert", iotcore.WHO_ALL, function (v: number, from: string, to: string) {
    sollCount++
    sollLast = v
    sollFrom = from
    say("RECV number sollwert=" + v + " from=" + from + " to=" + (to == "" ? "all" : to))
})
iotcore.onText("nachricht", iotcore.WHO_ALL_BUT_ME, function (text: string, from: string, to: string) {
    say("RECV text nachricht=" + text + " from=" + from)
})
iotcore.onSent("", function (feed: string, v: number, to: string) {
    sentCount++
})

// ---- local self-checks (no host needed) ------------------------------------

basic.pause(500) // the hello goes out first (deferred to >= 250 ms uptime)

check("scope from read blocks", iotcore.scopeCode() == "a", "scope=" + iotcore.scopeCode() + ", want a")

iotcore.send("echo", 1)
basic.pause(200)
check("own value fires 'all'", echoAll == 1, "count=" + echoAll)
check("own value skips 'all but me'", echoButMe == 0, "count=" + echoButMe)

iotcore.send("Temperatur", 21.5)
check("read returns own value at once", iotcore.read("temperatur", iotcore.WHO_ME) == 21.5,
    "read=" + iotcore.read("temperatur", iotcore.WHO_ME))

iot.empfangeVonAussen("IOT1:v:0::sollwert:42")
basic.pause(200)
check("downlink line fires handler", sollCount == 1 && sollLast == 42 && sollFrom == "0",
    "count=" + sollCount + " last=" + sollLast + " from=" + sollFrom)

iot.empfangeVonAussen("IOT1:v:" + iotcore.deviceId() + "::sollwert:99")
basic.pause(200)
check("own value coming back is ignored", sollCount == 1 && iotcore.read("sollwert") == 42,
    "count=" + sollCount + " read=" + iotcore.read("sollwert"))

iot.empfangeVonAussen("IOT1:v:0:12345:sollwert:5")
basic.pause(200)
check("value for another device fires nothing", sollCount == 1, "count=" + sollCount)

check("clock unknown before t:", !iotcore.timeKnown(), "clock=" + clockText())
iot.empfangeVonAussen("IOT1:t:1790000000")
iot.empfangeVonAussen("IOT1:z:120")
check("clock set by t:/z:", iotcore.timeKnown() && Math.abs(iotcore.unixSeconds() - 1790000000) <= 1,
    "unix=" + iotcore.unixSeconds() + " local=" + clockText() + " (want 16:13:20)")

say("probe injected: expect the hello lines IOT1:r/i(/s/h) right below")
iot.empfangeVonAussen("IOT1:?")
basic.pause(300)

const sentBefore = sentCount
iotcore.send("temperatur", 22)
iotcore.sendText("nachricht", "hallo: mit Doppelpunkt")
basic.pause(2600)
check("onSent fires when lines leave", sentCount >= sentBefore + 2,
    "sent " + (sentCount - sentBefore) + " since, queued=" + iotcore.queued())

// Back-to-back lines through the one-slot mailbox: all must arrive, in order.
iotcore.setSync(0)
for (let i = 0; i < 12; i++) iotcore.send("burst", i)
basic.pause(1500)
iotcore.setSync(2000)
check("burst of 12 drained", iotcore.queued() == 0, "queued=" + iotcore.queued()
    + "; expect IOT1:d::burst:0 … 11 in order on serial and in Campus")

say("CAMPUS-CORE-END checks=" + checks + " fails=" + fails)
basic.showNumber(fails)

// ---- keep running for a Campus test ----------------------------------------

let n = 0
loops.everyInterval(5000, function () {
    n++
    iotcore.send("zaehler", n)
    iotcore.send("Temperatur", input.temperature())
    say("status " + stateText() + " clock=" + clockText() + " queued=" + iotcore.queued()
        + " sent=" + sentCount + " sollwert=" + iotcore.read("sollwert"))
})
