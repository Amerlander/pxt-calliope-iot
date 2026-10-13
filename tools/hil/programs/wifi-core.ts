// HIL soak test: the IoT core on the WLAN path — what a child's program does.
//
//   hil.py run programs/wifi-core.ts --variant v3 --var MINUTES=60 --start "=====SOAK=====" --end "=====SOAKEND=====" --trace-timeout 4000
//
// The core sends `soak_n` (a counter, +1 every second, interval "every second")
// and `soak_t` (temperature, every 10 s) through iotcore → wlanSender() →
// iotwifi.postIngest. The oracle is the server: every counter value 1..N must be
// in iot_points exactly once (no gap = nothing lost, no repeat = no duplicate),
// checked afterwards with `hil.py points` / a query on from_dev.
//
// A dashboard value `Licht` (set it in the dashboard during the run) must show up
// as a RECV line. The module has its own UART (UARTE1): this program prints over
// USB serial freely; the core does not touch USB serial on the WLAN path.
const MINUTES = $MINUTES
let sentOk = 0
let recv = 0
let lastLicht = -1
function line(s: string) { serial.writeLine(s) }

line("=====SOAK=====")
line("soak: " + MINUTES + " min, counter soak_n every 1 s, interval 1 s; set 'Licht' on the dashboard to test the downlink")
iotwifi.connect("$SSID", "$PW", SerialPin.C17, SerialPin.C16)
iotcore.setDashboard("$REF", "$SERVER")
iotcore.setInterval(1000)
iotcore.onSent("", function (feed: string, value: number, to: string) {
    if (feed == "soak_n") sentOk++
})
iotcore.onNumber("Licht", "", function (value: number, from: string, to: string) {
    recv++
    lastLicht = value
    line("RECV Licht=" + value + " from=" + from + " at " + control.millis() + " ms")
})
line("online=" + iotwifi.waitOnline(90000) + " id=" + iotcore.deviceId() + " server=" + iotcore.serverAddress())

const t0 = control.millis()
let n = 0
let nextStatus = t0 + 60000
while (control.millis() - t0 < MINUTES * 60000) {
    n++
    iotcore.send("soak_n", n)
    if (n % 10 == 0) iotcore.send("soak_t", input.temperature())
    if (control.millis() >= nextStatus) {
        nextStatus += 60000
        line("status t=" + Math.idiv(control.millis() - t0, 1000) + "s sent=" + n + " confirmed=" + sentOk +
            " queued=" + iotcore.queued() + " wifi=" + iotwifi.stateText() + " core=" + iotcore.status() +
            " err=" + iotcore.lastError() + "/" + iotwifi.lastError() + " rssi=" + iotwifi.rssi() +
            " clock=" + (iotcore.timeKnown() ? "" + iotcore.unixSeconds() : "--") +
            " engine lost=" + iotwlan.stats(4) + " resets=" + iotwlan.stats(1) + " busy=" + iotwlan.stats(2))
    }
    basic.pause(1000)
}
// Let the last batches drain.
for (let i = 0; i < 30 && iotcore.queued() > 0; i++) basic.pause(1000)
line("RESULT sent=" + n + " confirmed=" + sentOk + " queued=" + iotcore.queued() + " recvLicht=" + recv +
    " lastLicht=" + lastLicht + " wifi=" + iotwifi.stateText())
line("=====SOAKEND=====")
basic.showIcon(IconNames.Yes)
