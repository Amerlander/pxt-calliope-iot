// HIL: a program from Campus that showed a blank screen and never posted
// (2026-10-13). The program unchanged, plus one diagnostic line every 2 s over
// USB serial (free on the mini 3: the module has its own UART).
//
//   hil.py run programs/user-blank.ts --variant v3 --start "=====DIAG=====" --trace-timeout 90
//
// The user's program, as Campus/MakeCode generated it:
iot.onNumber("Licht", iot.who(IotWho.All), function (value, _from, to) {
    if (value == 1) {
        basic.setLedColors(0x00ff00, 0x00ff00, 0x00ff00)
    } else {
        basic.setLedColors(0xff0000, 0xff0000, 0xff0000)
    }
})
iot.onSent("temperatur", function (feed, value, to) {
    basic.showIcon(IconNames.Heart)
    basic.showLeds(`
        . . . . .
        . . . . .
        . . . . .
        . . . . .
        . . . . .
        `)
})
iot.connectWifi("$SSID", "$PW")
iot.connectDashboard("$REF", "$SERVER")
iot.syncEvery(IotSync.Every2Seconds)
basic.forever(function () {
    iot.send("temperatur", input.temperature(), iot.target(IotTarget.All))
})

// Diagnosis.
let sends = 0
let confirmed = 0
iot.onSent("", function (feed, value, to) {
    confirmed++
})
control.inBackground(function () {
    serial.writeLine("=====DIAG=====")
    while (true) {
        serial.writeLine("DIAG t=" + Math.idiv(control.millis(), 1000) + "s status=" + iot.status() +
            " wifi=" + iotwifi.stateText() + " connected=" + iot.wifiConnected() +
            " err=" + iot.lastError() + "/" + iotwifi.lastError() + " rssi=" + iot.wifiSignal() +
            " queued=" + iotcore.queued() + " confirmed=" + confirmed +
            " rung=" + iotwifi.recoveryRung() + " port=" + iotwlan.stats(6) +
            " rx=" + iotwlan.stats(9) + " lost=" + iotwlan.stats(4) + " busy=" + iotwlan.stats(2))
        basic.pause(2000)
    }
})
