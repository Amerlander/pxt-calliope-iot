// Cold-boot panic isolation: open UARTE1 on C17/C16 only after $DELAY ms.
// Reports over USB serial every second so a late-opened trace still sees it.
const bootMs = input.runningTime()
let opened = "not yet"
let reply = ""
basic.showIcon(IconNames.Heart)
control.inBackground(function () {
    basic.pause($DELAY)
    const r = uarte1spike.begin(SerialPin.C17, SerialPin.C16, 115200)
    opened = "begin=" + r + " at " + input.runningTime() + " ms, uartes " + uarte1spike.instance()
    basic.showIcon(IconNames.Yes)
    uarte1spike.writeStr("AT\r\n")
    basic.pause(300)
    reply = uarte1spike.readAll().split("\r").join("").split("\n").join(" | ")
})
basic.forever(function () {
    serial.writeLine("DELAYTEST uptime " + input.runningTime() + " ms; " + opened + "; AT reply: " + reply + " ;end")
    basic.pause(1000)
})
