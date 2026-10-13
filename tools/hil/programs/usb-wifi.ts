// HIL: USB serial integrity under REAL WLAN traffic — the situation the bug
// was found in (a soak whose USB status lines lost characters while the core
// posted over WiFi), not the local AT loop of usb-integrity.ts.
//
//   hil.py build programs/usb-wifi.ts --name usb-wifi-dma --var MINUTES=10 --var TXMODE=dma
//   hil.py flash .work/usb-wifi-dma/built/binary.hex
//   python tools/hil/usbcheck.py --timeout 780 --save .work/usb-wifi-dma.txt
//
//   TXMODE=ring  old module TX through the codal::Serial ring
//   TXMODE=dma   the fix (EasyDMA without the ring)
//
// A background fiber writes the same numbered, checksummed lines as
// usb-integrity.ts over USB without a pause (format and markers are what
// usbcheck.py checks). The main fiber is a child's IoT program: WiFi, a
// dashboard, interval 1 s, one counter value per second. The summary's
// `posts` line feeds usbcheck's module-side check: bad = values the server
// never confirmed.

const MODE: string = "$TXMODE"
const MINUTES = $MINUTES
const FILL = "abcdefghijklmnopqrstuvwxyz012345"

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
let confirmed = 0
iotcore.onSent("", function (feed: string, value: number, to: string) {
    if (feed == "usb_n") confirmed++
})
iotwifi.connect("$SSID", "$PW", SerialPin.C17, SerialPin.C16)
iotcore.setDashboard("$REF", "$SERVER")
iotcore.setInterval(1000)
const online = iotwifi.waitOnline(90000)
// connect() opened the port; the switch only takes effect for later writes.
if (MODE == "ring") iotwlan.configure(3, 1)
const path = iotwlan.stats(10)
serial.writeString("=====USBSTART mode=" + MODE + " path=" + path + " online=" + online +
    " id=" + iotcore.deviceId() + "=====\r\n")
basic.showNumber(1)
started = true

const t0 = control.millis()
let n = 0
while (control.millis() - t0 < MINUTES * 60000) {
    n++
    iotcore.send("usb_n", n)
    basic.showNumber(Math.idiv(control.millis() - t0, 60000) % 10)
    basic.pause(1000)
}
for (let i = 0; i < 30 && iotcore.queued() > 0; i++) basic.pause(1000)
stopWriter = true
while (!writerDone) basic.pause(10)
basic.pause(200)

serial.writeString("=====USBSUM=====\r\n")
serial.writeString("mode=" + MODE + " path=" + path + " (1 dma, 2 ring, 3 shared)\r\n")
serial.writeString("lines=" + usbLines + "\r\n")
serial.writeString("posts ok=" + confirmed + " bad=" + (n - confirmed) + " sent=" + n + " queued=" + iotcore.queued() + "\r\n")
serial.writeString("wifi state=" + iotwifi.stateText() + " err=" + iotwifi.lastError() + " rssi=" + iotwifi.rssi() + "\r\n")
serial.writeString("stats busy=" + iotwlan.stats(2) + " stale=" + iotwlan.stats(3) + " lost=" + iotwlan.stats(4) +
    " resets=" + iotwlan.stats(1) + " rx=" + iotwlan.stats(9) + " dmaStuck=" + iotwlan.stats(11) + "\r\n")
serial.writeString("=====USBEND=====\r\n")
basic.showIcon(confirmed == n ? IconNames.Yes : IconNames.No)
