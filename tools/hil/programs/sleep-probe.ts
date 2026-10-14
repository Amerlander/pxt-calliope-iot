// HIL probe for module sleep (2026-10-14): what sleep mode does ESP-AT run by
// default, does the radio go off with AT+CWMODE=0, and how long does waking
// (radio on + join) take? Facts for the design of the sleep block.
//
//   hil.py run programs/sleep-probe.ts --variant v3 --start "=====SLEEP=====" --end "=====SLEEPEND=====" --trace-timeout 120
function lines(): string {
    let out = ""
    for (let i = 0; i < iotwlan.lineCount(); i++) out = out + (i > 0 ? "|" : "") + iotwlan.line(i)
    return out
}
function cmd(label: string, c: string, ms: number): number {
    const t = control.millis()
    const r = iotwlan.command(c, ms)
    serial.writeLine(label + " code=" + r + " " + (control.millis() - t) + "ms lines=" + lines())
    return r
}
function urcs(): string {
    let out = ""
    let u = iotwlan.takeUrc()
    while (u > 0) {
        out = out + (out.length > 0 ? "," : "") + (u & 255)
        u = iotwlan.takeUrc()
    }
    return out
}

basic.showNumber(0)
serial.writeLine("=====SLEEP=====")
const port = iotwlan.begin(SerialPin.C17, SerialPin.C16, 115200)
serial.writeLine("begin=" + port + " wake=" + iotwlan.wake(6, 500))
iotwlan.echoOff(1000)
cmd("GMR", "AT+GMR", 2000)
cmd("SLEEP?", "AT+SLEEP?", 1000)
cmd("SLEEPWKCFG?", "AT+SLEEPWKCFG?", 1000)
cmd("CWMODE?", "AT+CWMODE?", 1000)
cmd("SYSSTORE=0", "AT+SYSSTORE=0", 1000)
cmd("CWMODE=1", "AT+CWMODE=1", 2000)
let t = control.millis()
cmd("CWJAP", "AT+CWJAP=\"$SSID\",\"$PW\"", 20000)
serial.writeLine("join-cold ms=" + (control.millis() - t) + " urcs=" + urcs())
cmd("CWSTATE?", "AT+CWSTATE?", 1000)
basic.showNumber(1)

// Radio off: disconnect, then mode 0.
cmd("CWQAP", "AT+CWQAP", 3000)
cmd("CWMODE=0", "AT+CWMODE=0", 2000)
serial.writeLine("after off urcs=" + urcs())
cmd("CWMODE? off", "AT+CWMODE?", 1000)
cmd("AT asleep", "AT", 500)
basic.pause(5000)
cmd("AT after 5s", "AT", 500)
basic.showNumber(2)

// Wake: radio on, join again (credentials repeated: SYSSTORE=0 keeps nothing).
t = control.millis()
cmd("CWMODE=1 wake", "AT+CWMODE=1", 2000)
cmd("CWJAP wake", "AT+CWJAP=\"$SSID\",\"$PW\"", 20000)
serial.writeLine("wake total ms=" + (control.millis() - t) + " urcs=" + urcs())
cmd("CWSTATE? wake", "AT+CWSTATE?", 1000)

// Modem sleep explicitly (stays connected).
cmd("SLEEP=1", "AT+SLEEP=1", 1000)
cmd("SLEEP? after", "AT+SLEEP?", 1000)
t = control.millis()
cmd("CWJAP? in modem sleep", "AT+CWJAP?", 2000)
serial.writeLine("query in modem sleep ms=" + (control.millis() - t))
cmd("SLEEP=0 restore", "AT+SLEEP=0", 1000)
serial.writeLine("=====SLEEPEND=====")
basic.showIcon(IconNames.Yes)
