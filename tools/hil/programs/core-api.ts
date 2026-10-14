// Compile/size check: every exported function of the IoT core used once,
// including the WLAN path (a fake sender), the BLE hooks and the simulator.
// Not meant to be flashed. Compare `generated code sizes` in built/binary.asm
// with tools/hil/programs/empty.ts for the core's share.
iotcore.setWlanSender(function (b: iotcore.Batch, c: iotcore.IngestContext) {
    const a = new iotcore.Answer()
    a.ok = b.feeds.length > 0 && c.dev != ""
    return a
})
iotcore.setDashboard("demo", "localhost:8090")
iotcore.setSync(1000)
iotcore.send("a", 1, iotcore.WHO_DASHBOARD)
iotcore.sendText("b", "x")
iotcore.sendNow()
iotcore.log("hi")
iotcore.onNumber("a", iotcore.WHO_OTHERS, function (v: number, f: string, t: string) { basic.showNumber(v) })
iotcore.onText("b", iotcore.WHO_ALL_BUT_ME, function (s: string, f: string, t: string) { basic.showString(s) })
iotcore.onSent("", function (f: string, v: number, t: string) { led.toggle(0, 0) })
iot.setzeZusatzKanal(function (line: string) { })
iot.empfangeVonAussen("IOT1:v:0::a:1")
basic.showNumber(iotcore.read("a", iotcore.WHO_ME, iotcore.WHO_ALL) + iotcore.queued() + iotcore.status()
    + iotcore.unixSeconds() + iotcore.localSeconds() + iotcore.zoneMinutes() + (iotcore.timeKnown() ? 1 : 0))
basic.showString(iotcore.readText("b") + iotcore.lastError() + iotcore.deviceId() + iotcore.deviceName()
    + iotcore.scopeCode() + iotcore.reference() + iotcore.serverAddress())
