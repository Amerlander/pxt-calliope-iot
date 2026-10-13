// HIL: does module traffic on UARTE1 corrupt USB serial output written at the
// same time? (mini 3 only: on a shared UART there is no USB output at all.)
//
// Bug found in a 60-minute soak: USB lines lost characters ("cock=" for
// "clock=") while HTTPCPOSTs ran on UARTE1. Cause: codal::Serial's TX ring
// raises one TX_EMPTY event shared by all serial ports, and a USB writer
// waiting for room wakes on the module port's event and overwrites a byte
// not yet sent (details in wlanport.cpp, dmaWrite).
//
// One source, two builds (hil.py --var):
//   TXMODE=ring  old module TX through the codal::Serial ring: expect corruption
//   TXMODE=dma   the fix, EasyDMA without the ring (also the default): expect 0
//
// A background fiber writes numbered, checksummed lines over USB without a
// pause, so the USB TX ring (20 bytes) is always full and its writer always
// waiting: the moment the bug needs. The main fiber meanwhile keeps the
// module busy with local commands only (no WiFi, no server):
//   AT        x10   many short writes, each ending with an empty TX ring
//   AT+GMR          a longer reply
//   AT+IOTCHK=...   200-byte junk command with echo on: two DMA chunks; the
//                   module echoes it and answers ERROR. The engine skips the
//                   echo only on an exact match, so a corrupted module TX
//                   shows up as an info line.
//   AT+CWLAP        every 15 s, a long burst of scan results
// After 60 s the writer stops and a summary is printed between markers.
// Host side: tools/hil/usbcheck.py reads the port and checks every line.
//
// Line format: U<n>:<32 fixed chars>:<h>, h = hash of "U<n>:<32 chars>"
// (h = (h * 31 + code) & 0xffff), the same function as in usbcheck.py.

const MODE: string = "$TXMODE" // left as "$TXMODE" when not substituted: counts as dma
const RUN_MS = 60000
const FILL = "abcdefghijklmnopqrstuvwxyz012345"
const PAT = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const JUNK = "AT+IOTCHK=\"" + (PAT + PAT + PAT).substr(0, 186) + "\"" // 198 bytes + CRLF

function hash(s: string): number {
    let h = 0
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff
    return h
}

let started = false
let stopWriter = false
let writerDone = false
let usbLines = 0
control.inBackground(function () {
    while (!started) basic.pause(20)
    while (!stopWriter) {
        usbLines++
        const body = "U" + usbLines + ":" + FILL
        serial.writeString(body + ":" + hash(body) + "\r\n")
    }
    writerDone = true
})

basic.showNumber(0)
const port = iotwlan.begin(SerialPin.C17, SerialPin.C16, 115200) // waits until 5 s uptime
if (MODE == "ring") iotwlan.configure(3, 1)
const path = iotwlan.stats(10)
const awake = iotwlan.wake(5, 800)
// Echo ON on purpose: every command comes back and is checked by the engine.
const echo = iotwlan.command("ATE1", 1000)
serial.writeString("=====USBSTART mode=" + MODE + " port=" + port + " path=" + path +
    " wake=" + awake + " ate1=" + echo + "=====\r\n")
basic.showNumber(1)
started = true

let atOk = 0, atBad = 0, gmrOk = 0, gmrBad = 0, junkOk = 0, junkBad = 0, lapOk = 0, lapBad = 0
let codes = ""
const t0 = control.millis()
let nextLap = t0 + 5000
while (control.millis() - t0 < RUN_MS) {
    for (let i = 0; i < 10; i++) {
        const c = iotwlan.command("AT", 1000)
        if (c == IotAtResult.OK && iotwlan.lineCount() == 0) atOk++
        else { atBad++; if (codes.length < 60) codes = codes + "a" + c + "/" + iotwlan.lineCount() + " " }
    }
    const g = iotwlan.command("AT+GMR", 2000)
    if (g == IotAtResult.OK && iotwlan.line(0).indexOf("AT version:") == 0) gmrOk++
    else { gmrBad++; if (codes.length < 60) codes = codes + "g" + g + " " }
    const rx0 = iotwlan.stats(9)
    const j = iotwlan.command(JUNK, 2000)
    // ERROR, no info line (the echo matched exactly) and the echo really came back.
    if (j == IotAtResult.Error && iotwlan.lineCount() == 0 && iotwlan.stats(9) - rx0 >= JUNK.length) junkOk++
    else { junkBad++; if (codes.length < 60) codes = codes + "j" + j + "/" + iotwlan.lineCount() + " " }
    if (control.millis() > nextLap) {
        const l = iotwlan.command("AT+CWLAP", 10000)
        if (l == IotAtResult.OK) lapOk++
        else lapBad++
        nextLap += 15000
    }
    basic.showNumber(Math.idiv(control.millis() - t0, 10000)) // one digit: no scrolling
}
stopWriter = true
while (!writerDone) basic.pause(10)
basic.pause(200)

serial.writeString("=====USBSUM=====\r\n")
serial.writeString("mode=" + MODE + " port=" + port + " path=" + path + " (1 dma, 2 ring, 3 shared)\r\n")
serial.writeString("lines=" + usbLines + "\r\n")
serial.writeString("at ok=" + atOk + " bad=" + atBad + "\r\n")
serial.writeString("gmr ok=" + gmrOk + " bad=" + gmrBad + "\r\n")
serial.writeString("junk ok=" + junkOk + " bad=" + junkBad + "\r\n")
serial.writeString("cwlap ok=" + lapOk + " bad=" + lapBad + "\r\n")
serial.writeString("bad codes: " + codes + "\r\n")
serial.writeString("stats busy=" + iotwlan.stats(2) + " stale=" + iotwlan.stats(3) + " lost=" + iotwlan.stats(4) +
    " ringStalls=" + iotwlan.stats(5) + " rx=" + iotwlan.stats(9) + " dmaStuck=" + iotwlan.stats(11) + "\r\n")
serial.writeString("=====USBEND=====\r\n")
basic.showIcon(atBad + gmrBad + junkBad == 0 ? IconNames.Yes : IconNames.No)
