// HIL: the sleep block and automatic sleep at a sync interval of a minute.
//
//   hil.py run programs/sleep-wifi.ts --variant v3 --start "=====SLEEPWIFI=====" --end "=====SLEEPWIFIEND=====" --trace-timeout 240
//
// A: send, sleep block -> radio off; after 10 s a send wakes the module and
//    goes through (how long does it take?).
// B: sync every minute -> after the sync the radio goes off by itself; the
//    next value goes at the next sync, waking the module.
let confirmed = 0
iot.onSent("", function (feed, value) {
    confirmed++
    serial.writeLine("SENT " + feed + "=" + value + " at " + control.millis() + " ms")
})
function line(s: string) {
    serial.writeLine(s + " | t=" + control.millis() + " wifi=" + iotwifi.stateText() + " status=" + iot.status() +
        " confirmed=" + confirmed + " err=" + iotwifi.lastError())
}
function waitFor(n: number, ms: number): number {
    const t = control.millis()
    while (confirmed < n && control.millis() - t < ms) basic.pause(50)
    return control.millis() - t
}
function waitState(want: string, ms: number): number {
    const t = control.millis()
    while (iotwifi.stateText() != want && control.millis() - t < ms) basic.pause(50)
    return control.millis() - t
}

serial.writeLine("=====SLEEPWIFI=====")
iot.connectWifi("$SSID", "$PW")
iot.connectDashboard("$REF", "$SERVER")
line("online=" + iotwifi.waitOnline(60000))

// A: the sleep block
iot.send("sleep_a", 1)
line("A1 confirmed after " + waitFor(1, 15000) + " ms")
iot.sleepWifi()
line("A2 after sleep block (expect wifi=sleeping, status=5)")
basic.pause(10000)
line("A3 still asleep after 10 s")
iot.send("sleep_a", 2)
line("A4 wake+post took " + waitFor(2, 40000) + " ms")

// B: sync every minute -> auto sleep
iot.syncEvery(IotSync.EveryMinute)
basic.pause(1500) // the floor
iot.send("sleep_b", 1)
line("B1 confirmed after " + waitFor(3, 20000) + " ms")
line("B2 asleep after " + waitState("sleeping", 5000) + " ms")
iot.send("sleep_b", 2)
line("B3 queued, waiting for the next sync")
line("B4 next sync took " + waitFor(4, 90000) + " ms")
line("B5 asleep again after " + waitState("sleeping", 8000) + " ms")
serial.writeLine("=====SLEEPWIFIEND=====")
basic.showIcon(confirmed == 4 ? IconNames.Yes : IconNames.No)
