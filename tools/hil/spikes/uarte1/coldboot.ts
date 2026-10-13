// Cold-boot check (plan E8). Reports over USB serial, talks to the module over
// UARTE1, repeats its status every second so a trace opened late still sees it.
const SET_AUTOCONN = $AUTOCONN   // -1 = leave the module's setting alone
const bootMs = input.runningTime()
let accel = "not read"
let autoconnBefore = "?"
let autoconnSet = "untouched"

function vis(s: string): string {
    return s.split("\r").join("").split("\n").join(" | ")
}
function at(cmd: string, ms: number): string {
    uarte1spike.writeStr(cmd + "\r\n")
    let buf = ""
    const t = input.runningTime()
    while (input.runningTime() - t < ms) {
        buf = buf + uarte1spike.readAll()
        if (buf.includes("OK") || buf.includes("ERROR")) break
        basic.pause(5)
    }
    return buf
}

// Touch the accelerometer first: its detection over I2C is where panic 050
// came from. If the rail sagged while the module booted, we never get past here.
accel = "x=" + input.acceleration(Dimension.X)

uarte1spike.begin(SerialPin.C17, SerialPin.C16, 115200)
basic.pause(300)
uarte1spike.readAll()
at("ATE0", 1000)
autoconnBefore = vis(at("AT+CWAUTOCONN?", 1000))
if (SET_AUTOCONN >= 0) {
    autoconnSet = vis(at("AT+CWAUTOCONN=" + SET_AUTOCONN, 1000))
}

basic.forever(function () {
    serial.writeLine("=====COLD=====")
    serial.writeLine("uptime " + input.runningTime() + " ms (program started at " + bootMs + ")")
    serial.writeLine("accel " + accel)
    serial.writeLine("autoconn before: " + autoconnBefore)
    serial.writeLine("autoconn set " + SET_AUTOCONN + ": " + autoconnSet)
    serial.writeLine("=====END=====")
    basic.pause(1000)
})
