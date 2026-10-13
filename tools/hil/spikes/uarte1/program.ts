// UARTE1 spike: AT over a second hardware UART while USB serial keeps printing.
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

basic.pause(1500)
serial.writeLine("=====SPIKE=====")
serial.writeLine("uartes enabled before: " + uarte1spike.instance())
const r = uarte1spike.begin(SerialPin.C17, SerialPin.C16, 115200)
serial.writeLine("begin -> " + r + ", uartes enabled after: " + uarte1spike.instance())
basic.pause(200)
serial.writeLine("boot noise: " + vis(uarte1spike.readAll()))
serial.writeLine("AT -> " + vis(at("AT", 1000)))
serial.writeLine("ATE0 -> " + vis(at("ATE0", 1000)))
serial.writeLine("GMR -> " + vis(at("AT+GMR", 1500)))
serial.writeLine("CWSTATE -> " + vis(at("AT+CWSTATE?", 1500)))
serial.writeLine("usb still alive after AT exchange")
serial.writeLine("=====END=====")
basic.forever(function () {
    serial.writeLine("usb alive " + input.runningTime())
    basic.pause(3000)
})
