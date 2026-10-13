// Minimal cold-boot reference WITH an extension that ships C++ (cloud-built
// native image), but without opening the second UART: only reads registers.
const bootMs = input.runningTime()
const uartes = uarte1spike.instance()
basic.showIcon(IconNames.Heart)
basic.forever(function () {
    serial.writeLine("MINICPP alive, uptime " + input.runningTime() + " ms, uartes " + uartes + ", started at " + bootMs)
    basic.pause(1000)
})
