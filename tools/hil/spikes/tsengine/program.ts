// HIL check of the TS AT engine against the real ESP32-C3 (redirect port).
// Collects results while the UART belongs to the module, prints them after.
let log = ""
function note(s: string) { log = log + s + "\n" }
function flat(s: string): string { return s.split("\r").join("").split("\n").join("|") }
function res(label: string, r: iotwlan.AtResult) {
    note(label + " code=" + r.code + " lines=" + flat(r.lines.join("\n")) +
        (r.payload.length > 0 ? " payload(" + r.payload.length + ")=" + flat(r.payload.substr(0, 90)) : "") +
        (r.truncated ? " TRUNCATED" : "") + (r.reset ? " RESET" : ""))
}

basic.showNumber(0)
while (control.millis() < 5000) basic.pause(100)   // cold-boot rule
const port = new iotwlan.SerialPort(SerialPin.C17, SerialPin.C16, BaudRate.BaudRate115200)
port.open()
const at = iotwlan.startEngine(port)

basic.showNumber(1)
note("sync=" + at.sync(5, 800) + " ate0=" + at.disableEcho(1000))
const caps = at.detect(2000)
note("caps family=" + caps.family + " ver=" + caps.version + " httpClient=" + caps.httpClient +
    " passive=" + caps.passiveRecv + " tls=" + caps.tls + " sysstore=" + caps.sysstore)
res("CWSTATE", at.command("AT+CWSTATE?", 2000))
basic.showNumber(2)
res("CWJAP", at.command("AT+CWJAP=\"$SSID\",\"$PW\"", 20000))

basic.showNumber(3)
res("HTTPS GET", at.command("AT+HTTPCLIENT=2,0,\"https://campus-api.calliope.cc/api/health\",,,2", 15000))

basic.showNumber(4)
const body = "{\"t\":\"$REF\",\"dev\":\"-779\",\"now\":1,\"scope\":\"\",\"since\":0,\"d\":[{\"f\":\"temperatur\",\"v\":45,\"dt\":0,\"to\":\"\"}]}"
res("HTTPCPOST", at.sendWithPrompt("AT+HTTPCPOST=\"$SERVER/ingest\"," + body.length + ",1,\"Content-Type: application/json\"", body, 10000))

basic.showNumber(5)
res("RECVMODE=1", at.command("AT+CIPRECVMODE=1", 1500))
res("CIPSTART", at.command("AT+CIPSTART=\"TCP\",\"192.168.1.172\",8090", 8000))
const body2 = "{\"t\":\"$REF\",\"dev\":\"-779\",\"now\":2,\"scope\":\"\",\"since\":0,\"d\":[{\"f\":\"temperatur\",\"v\":46,\"dt\":0,\"to\":\"\"}]}"
const req = "POST /api/iot/v1/ingest HTTP/1.1\r\nHost: 192.168.1.172:8090\r\nContent-Type: application/json\r\nContent-Length: " + body2.length + "\r\nConnection: close\r\n\r\n" + body2
res("CIPSEND", at.sendWithPrompt("AT+CIPSEND=" + req.length, req, 8000))
at.pumpFor(800)
note("passivePending=" + at.passivePending + " linkOpen=" + at.linkOpen)
let total = 0
let last = ""
for (let k = 0; k < 12; k++) {
    const r = at.command("AT+CIPRECVDATA=200", 2000)
    if (r.payload.length == 0) break
    total += r.payload.length
    last = r.payload
}
note("passive pulled " + total + " bytes; tail=" + flat(last.substr(last.length > 70 ? last.length - 70 : 0)))
res("RECVMODE=0", at.command("AT+CIPRECVMODE=0", 1500))
note("counters: urcs=" + at.urcCount() + " lost=" + at.lost + " busy=" + at.busyCount + " stale=" + at.staleFinals + " resets=" + at.resets)
let u = 0
while (at.urcCount() > 0 && u < 20) { note("urc " + at.takeUrc()); u++ }

serial.redirectToUSB()
basic.showIcon(IconNames.Yes)
basic.forever(function () {
    serial.writeLine("=====TSENGINE=====")
    serial.writeLine(log)
    serial.writeLine("=====END=====")
    basic.pause(4000)
})
