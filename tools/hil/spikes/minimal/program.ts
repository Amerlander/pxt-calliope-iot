// Minimal cold-boot reference: core only, no extension, no C++.
const bootMs = input.runningTime()
basic.showIcon(IconNames.Heart)
basic.forever(function () {
    serial.writeLine("MINIMAL alive, uptime " + input.runningTime() + " ms, started at " + bootMs)
    basic.pause(1000)
})
