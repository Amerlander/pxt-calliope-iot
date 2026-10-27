// Compile test: every block of the extension is called once here, so that
// `pxt build` type-checks them all. The same program, with more realistic
// use, is tools/hil/programs/blocks-all.ts.

// Connection
iot.connect("school-wifi", "secret123", "weather-station")
iot.connect("school-wifi", "secret123", "weather-station", "https://campus-api.calliope.cc", SerialPin.C17, SerialPin.C16)
iot.connect("", "", "")
iot.connectWifi("school-wifi", "secret123")
iot.connectWifi("school-wifi", "secret123", SerialPin.C17, SerialPin.C16)
iot.connectDashboard("weather-station")
iot.connectDashboard("weather-station", "https://campus-api.calliope.cc")
iot.syncEvery(IotSync.Every2Seconds)
iot.syncEvery(IotSync.Every5Seconds)
iot.syncEvery(IotSync.Every10Seconds)
iot.syncEvery(IotSync.EveryMinute, IotSyncMode.OnlySend)
iot.syncEvery(IotSync.Every10Minutes, IotSyncMode.SendAndReceive)
iot.syncEvery(IotSync.EveryHour)
iot.sleepWifi()

// Send
iot.send("temperature", input.temperature())
iot.send("temperature", input.temperature(), iot.target(IotTarget.Dashboard))
iot.sendText("message", "hello")
iot.sendText("message", "hello", iot.target(IotTarget.All))
iot.sendNow()
iot.onSent("", function (feed: string, value: number) {
    led.toggle(0, 0)
})

// Receive
iot.onNumber("setpoint", function (value: number, from: string) {
    basic.showNumber(value)
})
iot.onNumber("setpoint", function (value: number, from: string) {
    basic.showNumber(value)
}, iot.who(IotWho.Dashboard))
iot.onText("message", function (text: string, from: string) {
    basic.showString(text)
}, iot.who(IotWho.OtherDevices))
let n = iot.read("setpoint")
n += iot.read("setpoint", iot.who(IotWho.AllButMe), iot.who(IotWho.OnlyThisDevice))
let s = iot.readText("message")
s += iot.readText("message", iot.who(IotWho.All), iot.who(IotWho.Dashboard))

// Time
if (iot.timeKnown()) {
    s += iot.time() + iot.date()
    n += iot.hour() + iot.minute() + iot.second() + iot.timestamp()
}

// Diagnosis
if (iot.status() == iot.statusValue(IotStatus.Connected)) n++
if (iot.status() == IotStatus.NoWifiModule) n--
if (iot.status() == IotStatus.Sleeping) n--
if (iot.wifiConnected()) n += iot.wifiSignal()
s += iot.lastError() + iot.deviceName() + iot.moduleVersion() + iot.moduleInfo()
iot.log(s + n)
