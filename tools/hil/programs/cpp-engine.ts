// HIL check of the C++ AT engine (wlanat.cpp / wlanport.cpp) against a real module.
//
// On mini 3 the engine opens its own UART (UARTE1), so USB serial stays free:
// results are printed live, while a background fiber keeps writing a heartbeat
// over USB at the same time — that exercises simultaneous TX on both UARTs.
// The whole log is repeated at the end between markers for `hil.py trace --last`.
let log = ""
// Live output only with an own UART (mini 3, begin() == 1). On the mini 2 the
// one UART belongs to the module while the engine runs: anything written to
// `serial` would land in the AT parser. The log is printed after the run.
let live = false
function note(s: string) {
    log = log + s + "\n"
    if (live) serial.writeLine(s)
}
function flat(s: string): string { return s.split("\r").join("").split("\n").join("|") }
function lines(): string {
    let out = ""
    for (let i = 0; i < iotwlan.lineCount(); i++) out = out + (i > 0 ? "|" : "") + iotwlan.line(i)
    return out
}
function res(label: string, code: number) {
    const n = iotwlan.payloadLength()
    note(label + " code=" + code + " flags=" + iotwlan.resultFlags() + " lines=" + lines() +
        (n > 0 ? " payload(" + n + ")=" + flat(iotwlan.payload(0, 90)) : ""))
}

let heartbeats = 0
control.inBackground(function () {
    while (true) {
        if (live) {
            heartbeats++
            serial.writeLine("hb " + heartbeats + " t=" + control.millis())
        }
        basic.pause(250)
    }
})

basic.showNumber(0)
const t0 = control.millis()
const port = iotwlan.begin(SerialPin.C17, SerialPin.C16, 115200)
live = port == 1
note("=====CPP=====")
note("begin=" + port + " (1 own UART, 2 redirect) after " + (control.millis() - t0) + " ms, uptime " + control.millis())
note("portKind=" + iotwlan.stats(6) + " tickDrain=" + iotwlan.stats(8))

basic.showNumber(1)
note("wake=" + iotwlan.wake(5, 800) + " echoOff=" + iotwlan.echoOff(1000))
const d = iotwlan.detect(2000)
note("detect flags=" + (d & 255) + " family=" + ((d >> 8) & 255) + " major=" + (d >> 16) +
    " at=" + iotwlan.moduleInfo(0) + " chip=" + iotwlan.moduleInfo(1) + " bin=" + iotwlan.moduleInfo(2))
res("CWSTATE", iotwlan.command("AT+CWSTATE?", 2000))

basic.showNumber(2)
res("CWJAP", iotwlan.command("AT+CWJAP=\"$SSID\",\"$PW\"", 20000))
note("status=" + iotwlan.status())

basic.showNumber(3)
res("HTTPS GET", iotwlan.command("AT+HTTPCLIENT=2,0,\"https://campus-api.calliope.cc/api/health\",,,2", 15000))

basic.showNumber(4)
const body = "{\"t\":\"$REF\",\"dev\":\"-780\",\"now\":1,\"scope\":\"\",\"since\":0,\"d\":[{\"f\":\"temperatur\",\"v\":47,\"dt\":0,\"to\":\"\"}]}"
res("HTTPCPOST", iotwlan.sendData("AT+HTTPCPOST=\"$SERVER/ingest\"," + body.length + ",1,\"Content-Type: application/json\"", body, 10000))

// Server floor: one batch per device per 900 ms.
basic.pause(1200)

basic.showNumber(5)
function tcpPost(v: number): string {
    const b = "{\"t\":\"$REF\",\"dev\":\"-780\",\"now\":" + v + ",\"scope\":\"\",\"since\":0,\"d\":[{\"f\":\"temperatur\",\"v\":" + v + ",\"dt\":0,\"to\":\"\"}]}"
    return "POST /api/iot/v1/ingest HTTP/1.1\r\nHost: 192.168.1.172:8090\r\nContent-Type: application/json\r\nContent-Length: " +
        b.length + "\r\nConnection: close\r\n\r\n" + b
}
res("RECVMODE=1", iotwlan.command("AT+CIPRECVMODE=1", 1500))
res("CIPSTART", iotwlan.command("AT+CIPSTART=\"TCP\",\"192.168.1.172\",8090", 8000))
const req = tcpPost(48)
res("CIPSEND passive", iotwlan.sendData("AT+CIPSEND=" + req.length, req, 8000))
iotwlan.pumpFor(800)
note("passivePending=" + iotwlan.stats(0))
let total = 0
let tail = ""
for (let k = 0; k < 12; k++) {
    const c = iotwlan.command("AT+CIPRECVDATA=200", 2000)
    const n = iotwlan.payloadLength()
    if (c != IotAtResult.OK || n == 0) break
    total += n
    tail = iotwlan.payload(n > 70 ? n - 70 : 0, 70)
}
note("passive pulled " + total + " bytes; tail=" + flat(tail))
res("RECVMODE=0", iotwlan.command("AT+CIPRECVMODE=0", 1500))

basic.pause(1200)

basic.showNumber(6)
res("CIPSTART", iotwlan.command("AT+CIPSTART=\"TCP\",\"192.168.1.172\",8090", 8000))
const req2 = tcpPost(49)
res("CIPSEND active", iotwlan.sendData("AT+CIPSEND=" + req2.length, req2, 8000))
iotwlan.waitRecv(400, 5000)
iotwlan.pumpFor(500)
let active = ""
let got = 0
while (iotwlan.recvAvailable() > 0 && got < 4000) {
    const part = iotwlan.recvTake(200)
    got += part.length
    active = part
}
note("active received " + got + " bytes; tail=" + flat(active.substr(active.length > 70 ? active.length - 70 : 0)))

basic.showNumber(7)
let urcs = ""
let u = iotwlan.takeUrc()
while (u != 0) {
    urcs = urcs + (u & 255) + ":" + (u >> 8) + " "
    u = iotwlan.takeUrc()
}
note("urcs " + urcs)
note("stats passive=" + iotwlan.stats(0) + " resets=" + iotwlan.stats(1) + " busy=" + iotwlan.stats(2) +
    " stale=" + iotwlan.stats(3) + " lost=" + iotwlan.stats(4) + " ringStalls=" + iotwlan.stats(5) +
    " tickDrain=" + iotwlan.stats(8))
note("heartbeats during run=" + heartbeats)
note("=====END=====")

// mini 2: hand the UART back to USB for the summary (the engine is done).
if (!live) serial.redirectToUSB()
basic.showIcon(IconNames.Yes)
basic.forever(function () {
    serial.writeLine("=====SUMMARY=====")
    serial.writeLine(log)
    serial.writeLine("=====SUMEND=====")
    basic.pause(5000)
})
