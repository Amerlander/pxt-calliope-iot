// HIL program: every block of the iot extension (iot.ts) once, in a program a
// class could write: a weather station that sends its temperature over WiFi,
// takes a setpoint from the dashboard, chats with the other minis, shows the
// time, and tells what is wrong.
//
// Build:  hil.py build tools/hil/programs/blocks-all.ts --name blocks-all --variant v3
//         hil.py build tools/hil/programs/blocks-all.ts --name blocks-all-v2 --variant v2
//
// A compile check for the block layer (and the code size of a full program);
// not meant as a device test. The WiFi credentials are placeholders on purpose:
// nothing secret ends up in the build directory.

// Connection
iot.connect("school-wifi", "secret123", "weather-station", "https://campus-api.calliope.cc", SerialPin.C17, SerialPin.C16)
iot.syncEvery(IotSync.Every2Seconds)
iot.syncEvery(IotSync.EveryMinute, IotSyncMode.OnlySend)
iot.sleepWifi()

let setpoint = 22

// Receive
iot.onNumber("setpoint", iot.who(IotWho.Dashboard), function (value, from) {
    setpoint = value
    basic.showNumber(value)
})
iot.onText("chat", iot.who(IotWho.OtherDevices), function (text, from) {
    basic.showString(text)
})

// Send
iot.onSent("", function (feed, value) {
    led.plot(4, 0)
    basic.pause(50)
    led.unplot(4, 0)
})
input.onButtonPressed(Button.A, function () {
    iot.sendText("chat", "hello from " + iot.deviceName())
    iot.sendNow()
})
input.onButtonPressed(Button.B, function () {
    // Diagnosis
    if (iot.status() == iot.statusValue(IotStatus.Connected)) {
        basic.showIcon(IconNames.Yes)
    } else if (iot.status() == iot.statusValue(IotStatus.NoWifiModule)) {
        basic.showString(iot.lastError())
    } else {
        basic.showString(iot.lastError() + " " + iot.moduleVersion())
    }
    if (iot.wifiConnected()) basic.showNumber(iot.wifiSignal())
})
input.onButtonPressed(Button.AB, function () {
    // Time
    if (iot.timeKnown()) {
        basic.showString(iot.time() + " " + iot.date())
        basic.showNumber(iot.hour() * 3600 + iot.minute() * 60 + iot.second())
    }
    basic.showNumber(iot.timestamp())
})

basic.forever(function () {
    const t = input.temperature()
    iot.send("temperature", t)
    let warm = 0
    if (t > setpoint) warm = 1
    iot.send("too-warm", warm)
    const mine = iot.read("temperature", iot.who(IotWho.OnlyThisDevice))
    const forMe = iot.read("setpoint", iot.who(IotWho.AllButMe), iot.who(IotWho.OnlyThisDevice))
    const last = iot.readText("chat")
    const any = iot.readText("chat", iot.who(IotWho.All), iot.who(IotWho.All))
    iot.log("t=" + mine + " setpoint=" + forMe + " chat=" + last + "/" + any + " " + iot.moduleInfo())
    basic.pause(5000)
})
