/**
 * Simulator transport: the simx panel (pxt-iot-sim) instead of a host.
 *
 * `serial.writeString` does NOT leave the simulator: pxt treats simulator
 * serial output as `{type:"serial"}` for the editor console, and the driver
 * has `break; //handled elsewhere` for it (pxt/pxtsim/simdriver.ts). What
 * leaves is a `messagepacket`, and one packet reaches three places, all of
 * them wanted: the simx panel listening on the data channel, every other
 * simulator frame, and the editor's parent window (the Campus tab).
 *
 * TWO CHANNELS, deliberately. The panel KEY is the repo name: pxt only creates
 * the panel iframe when it sees a packet on a channel equal to a key in
 * `simulatorExtensions` (targetconfig `approvedRepoLib`). The DATA channel is
 * `iot`, which the panel and Campus listen on. pxt-jacdac does the same
 * (`jacdac/pxt-jacdac` launches, `jacdac` carries). Merging them gives a panel
 * that launches and never hears anything, or lines sent to a panel that does
 * not exist.
 *
 * `control.simmessages` exists only in the JS simulator; on the device
 * `pxt::sendMessage` does not exist and the build fails ("function not found:
 * control.simmessages.send"). `//% shim=TD_NOOP` is pxt's way out: on the
 * device the call compiles to nothing (the body is not even compiled), in the
 * simulator the TypeScript body runs. EVERYTHING that touches
 * `control.simmessages` must sit behind such a function.
 */
namespace iotsim {
    let panelStarted = false
    let listening = false

    /**
     * The panel key: the repo name under which pxt-calliope/targetconfig.json
     * lists the simx panel (`approvedRepoLib["…"].simx`). THE one place. A
     * function returning a literal rather than a namespace constant: pxt runs
     * namespace initialisers in file order, and a constant read before its
     * initialiser ran is `undefined` (pxt-grove hit exactly that with
     * "Expected type string but received type undefined").
     */
    export function panelKey(): string {
        return "amerlander/pxt-calliope-iot"
    }

    /** The data channel the panel and Campus listen on. */
    export function dataChannel(): string {
        return "iot"
    }

    /** One uplink line into the simulator world. No-op on the device. */
    //% shim=TD_NOOP
    export function out(line: string): void {
        if (!iotcore.isSimulator()) return
        if (!panelStarted) {
            // The panel appears only once a dashboard is named. pxt creates the
            // iframe at the first packet on the key channel; doing that at the
            // first `IOT1:r:` would show "no dashboard" at every start, even
            // for programs that never name one. Same threshold as the `s:`/`h:`
            // lines of the hello, so panel and announcement cannot diverge.
            if (iotcore.reference() == "") return
            panelStarted = true
            control.simmessages.send(panelKey(), undefined)
            listen()
        }
        control.simmessages.send(dataChannel(), Buffer.fromUTF8(line))
    }

    /**
     * The way back: what the panel sends is, for the program, the same as a
     * line from serial. Without it the simulator is deaf (no `read`, no
     * handlers, no clock) while the panel beside it shows the values it just
     * fetched. The panel reads WITHOUT `dev`, so the device's own values come
     * back too; `iotcore.receive` drops them by sender id.
     */
    //% shim=TD_NOOP
    function listen(): void {
        if (listening) return
        listening = true
        control.simmessages.onReceived(dataChannel(), function (msg: Buffer) {
            if (!msg) return
            const text = msg.toString()
            if (text == "") return
            // One packet may carry several lines: the panel batches its values.
            const lines = text.split("\n")
            for (let i = 0; i < lines.length; i++) iotcampus.handleLine(lines[i])
        })
    }
}
