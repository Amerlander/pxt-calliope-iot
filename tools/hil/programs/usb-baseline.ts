// Baseline for usb-integrity: the same USB writer, NO extension activity at all.
// If lines go missing here too, the loss is on the host / DAPLink side.
//   hil.py run programs/usb-baseline.ts --variant v3 --no-ext ; usbcheck.py
const RUN_MS = 60000
const FILL = "abcdefghijklmnopqrstuvwxyz012345"
function hash(s: string): number {
    let h = 0
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff
    return h
}
basic.pause(5000)
serial.writeString("=====USBSTART mode=baseline=====\r\n")
let n = 0
const t0 = control.millis()
while (control.millis() - t0 < RUN_MS) {
    n++
    const body = "U" + n + ":" + FILL
    serial.writeString(body + ":" + hash(body) + "\r\n")
}
serial.writeString("=====USBSUM=====\r\nmode=baseline\r\nlines=" + n + "\r\n=====USBEND=====\r\n")
basic.showIcon(IconNames.Yes)
