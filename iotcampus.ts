/**
 * Campus transport: the `IOT1:` line protocol of Campus `wire.ts`.
 *
 *   device → campus
 *     IOT1:d:<to>:<feed>:<value>     datapoint (to empty = everyone)
 *     IOT1:l:<text>                  log line
 *     IOT1:h:<ref>                   hello; ref = token or slug, may be empty
 *     IOT1:s:<server>                where the program writes (ingest base URL)
 *     IOT1:r:<scope>                 what this program READS: d|g|a
 *     IOT1:i:<serial>                who the device IS (decimal, negative = simulator)
 *     IOT1:n:<key>:<label>           how a feed is SPELLED (key is folded)
 *   campus → device
 *     IOT1:v:<from>:<to>:<feed>:<value>   value from the dashboard or a peer
 *     IOT1:t:<unixSeconds>                clock (legacy: t:<sec>:<tzo>)
 *     IOT1:z:<tzOffsetMin>                zone, separate: t+z in one line was 21 bytes, one over BLE's 20
 *     IOT1:e:<code>                       error to show
 *     IOT1:?                              probe: "who are you?", answered with the hello
 *
 * The value is always LAST, so a text may contain colons without an escaping
 * rule; every other field is stripped of colons by the core.
 *
 * Every line goes to every open pipe, because the device cannot see which one
 * the host is reading, and Campus de-duplicates the copies (`isCrossPipeEcho`):
 *   - the RAM mailbox (iotdap, mini 3 over CMSIS-DAP),
 *   - USB serial (Campus path only; `writeString`, never `writeLine`, which
 *     pads to 32 bytes, and the padding would become part of the value),
 *   - the BLE side channel registered by the Campus-generated iotble.ts,
 *   - the simulator panel (iotsim.ts).
 *
 * THE UPLINK QUEUE. The mailbox has ONE slot per direction. The old device
 * waited at most 10 ms for the host to empty it, while the host looks only
 * every 50 ms when idle, so back-to-back lines (the four hello lines, a
 * flushed buffer) were lost. Serial used to save them, but over WLAN there is
 * no serial copy. Now lines wait in a queue that the core fiber drains (every
 * 10 ms while it is not empty), and a line goes to ALL pipes at the moment the
 * mailbox takes it, so the copies stay within milliseconds of each other and
 * the host's one-second echo window always pairs them. A host that stops
 * draining (cable pulled, BLE now) is given up on after 250 ms (120 ms before
 * any host was ever seen, i.e. at boot without one); from then on lines no
 * longer wait for it until a write gets through again.
 */
namespace iotcampus {
    const WIRE = "IOT1:"
    // A full buffer (24 points) plus labels plus a hello fits.
    const QUEUE_MAX = 48
    // Lines per core tick; serial writes block about 3 ms per line at 115200 baud.
    const PUMP_MAX = 12
    // IOTDAP_INBOUND_BODY in iotdap.cpp; a longer line is refused, never truncated.
    const MAILBOX_LINE_MAX = 252
    const MAILBOX_WAIT_MS = 250
    // Before the host has ever emptied the slot, "not seen" means either "no
    // host" or "host attached but nothing to empty yet" (the hello at boot).
    // Two host polls are enough to tell; without a host this costs 120 ms once.
    const MAILBOX_FIRST_WAIT_MS = 120
    // Lines fetched from the mailbox per tick. Usually there is one (the host
    // writes the next only after we freed the slot); the cap keeps a very fast
    // host from holding the fiber.
    const MAILBOX_READS = 4
    // The serial RX buffer must hold a whole line: the default is 20 bytes
    // (CODAL_SERIAL_DEFAULT_BUFFER_SIZE), and a line that overruns it is not
    // shortened but destroyed. Measured: `IOT1:v:0::Licht:1` (17) arrived,
    // `IOT1:v:-957520046::Licht:1` (26) vanished without a word. 128, not 254:
    // on a mini 2 with BLE a full 254-byte readString exceeds the largest heap
    // block. Only the RX buffer: setTxBufferSize once silenced the device.
    const RX_BUFFER = 128
    const RX_MAX = 200
    // The connection widget's Blocks-runtime probe on USB serial (see pollSerial).
    const HOST_PROBE = "H"

    let qLine: string[] = []
    let qSent: boolean[] = []
    let qFeed: string[] = []
    let qRaw: string[] = []
    let qTo: string[] = []

    let waiting = false
    let waitSince = 0
    let mailboxStuck = false
    let sideChannel: (line: string) => void = null

    let serialReady = false
    let serialForeign = false
    let rx = ""

    // ---- uplink ----------------------------------------------------------

    /** Lines are waiting: the core loop ticks fast until they are out. */
    export function busy(): boolean {
        return qLine.length > 0
    }

    /** A datapoint; `onSent` fires when it leaves. */
    export function queueData(to: string, feed: string, raw: string): void {
        push(WIRE + "d:" + to + ":" + feed + ":" + raw, true, feed, raw, to)
    }

    export function queueLabel(key: string, label: string): void {
        push(WIRE + "n:" + key + ":" + label, false, "", "", "")
    }

    export function queueLog(text: string): void {
        push(WIRE + "l:" + text, false, "", "", "")
    }

    /**
     * The announcement, in this order:
     *   r: the read scope goes BEFORE the reference check. Over Campus the
     *      dashboard field may stay empty (Campus takes the reference of the
     *      open program), but only this program can say whose values it wants.
     *   i: who is speaking, before the reference, so Campus knows the id at
     *      the first datapoint.
     *   s:, h: only when a reference is named; otherwise Campus would get an
     *      empty reference plus the default server and have to correct itself
     *      a moment later. The reference may carry colons, so it is LAST and
     *      on its own line.
     */
    export function hello(): void {
        push(WIRE + "r:" + iotcore.scopeCode(), false, "", "", "")
        push(WIRE + "i:" + iotcore.deviceId(), false, "", "", "")
        const ref = iotcore.reference()
        if (ref == "") return
        push(WIRE + "s:" + iotcore.serverAddress(), false, "", "", "")
        push(WIRE + "h:" + ref, false, "", "", "")
    }

    function push(line: string, sent: boolean, feed: string, raw: string, to: string): void {
        if (qLine.length >= QUEUE_MAX) {
            qLine.shift(); qSent.shift(); qFeed.shift(); qRaw.shift(); qTo.shift()
        }
        qLine.push(line); qSent.push(sent); qFeed.push(feed); qRaw.push(raw); qTo.push(to)
    }

    /** Drain the queue onto every open pipe. Called by the core loop. */
    export function pump(): void {
        // Over WLAN the serial line may be the module's (redirect fallback):
        // nothing of ours goes on it then (bug: the module answered every
        // IOT1 line with ERROR, which the AT matcher took for its own answer).
        const serialOk = !iotcore.usesWlan()
        let n = 0
        while (qLine.length > 0 && n < PUMP_MAX) {
            const line = qLine[0]
            const sent = qSent[0]
            const feed = qFeed[0]
            const raw = qRaw[0]
            const to = qTo[0]
            if (!toMailbox(line)) return
            // Taken out BEFORE the pipes below: a serial or BLE write can
            // yield, and another fiber may push (and on overflow shift) meanwhile.
            qLine.shift(); qSent.shift(); qFeed.shift(); qRaw.shift(); qTo.shift()
            if (serialOk) serial.writeString(line + "\r\n")
            if (sideChannel) sideChannel(line)
            iotsim.out(line)
            if (sent) iotcore.fireSent(feed, raw, to)
            n++
        }
    }

    /** true: the line may go to the other pipes now; false: wait for the host. */
    function toMailbox(line: string): boolean {
        if (line.length > MAILBOX_LINE_MAX) return true
        if (iotdap.schreibe(line)) {
            mailboxStuck = false
            waiting = false
            return true
        }
        // No host empties the slot (none attached, cable pulled, BLE now): do
        // not hold the other pipes for it.
        if (mailboxStuck) {
            waiting = false
            return true
        }
        const now = control.millis()
        if (!waiting) {
            waiting = true
            waitSince = now
            return false
        }
        const limit = iotdap.hoertJemandZu() ? MAILBOX_WAIT_MS : MAILBOX_FIRST_WAIT_MS
        if (now - waitSince < limit) return false
        // Given up on the host until a write gets through again (the slot only
        // empties when a host reads it). The line goes on without its mailbox
        // copy, never with a late copy: that would fall outside the host's
        // echo window and count twice.
        mailboxStuck = true
        waiting = false
        return true
    }

    // ---- downlink --------------------------------------------------------

    /** Read the mailbox and USB serial. Called by the core loop on the Campus path only. */
    export function poll(): void {
        for (let i = 0; i < MAILBOX_READS; i++) {
            const line = iotdap.lies()
            if (!line) break
            handleLine(line)
        }
        pollSerial()
    }

    /**
     * USB serial carries the probe `IOT1:?` (and downlink lines when there is
     * no mailbox). It is POLLED, not a `serial.onDataReceived` listener: pxt
     * keeps one handler per serial event, so a listener here would remove the
     * program's own `on serial received` (or be removed by it), and a listener
     * once read the WiFi module's answers away (`WIFI GOT IP` never seen).
     *
     * `readString` returns "" while a program fiber waits in `readLine`, so a
     * program reading serial that way never loses a byte. A program polling
     * serial itself can lose at most ONE line: the first line that is not
     * ours makes the extension keep its hands off USB serial for good.
     */
    function pollSerial(): void {
        if (serialForeign) return
        if (!serialReady) {
            serialReady = true
            serial.setRxBufferSize(RX_BUFFER)
        }
        const chunk = serial.readString()
        if (!chunk) return
        rx += chunk
        let nl = rx.indexOf("\n")
        while (nl >= 0) {
            const line = trimEnd(rx.substr(0, nl))
            rx = rx.substr(nl + 1, rx.length - nl - 1)
            // "H" is the connection widget's runtime probe, written over USB
            // serial after every flash (mini-connection-widget usb.ts
            // primeBlocksRuntimeProbe). Not the program's input: skip it.
            // Taking it for foreign input dropped the serial downlink for good,
            // and Campus' probe IOT1:? — sent over serial only — went
            // unanswered, so a tab connecting after boot never got a hello.
            if (line.length > 0 && line != HOST_PROBE) {
                if (line.substr(0, WIRE.length) != WIRE) {
                    foreignSerial()
                    return
                }
                handleLine(line)
            }
            nl = rx.indexOf("\n")
        }
        // A partial line that can no longer become ours: stop at once rather
        // than take more of the program's bytes.
        let start = 0
        while (start < rx.length && rx.charAt(start) == "\r") start++
        const head = rx.substr(start, Math.min(rx.length - start, WIRE.length))
        if (head != WIRE.substr(0, head.length) && head != HOST_PROBE) foreignSerial()
        else if (rx.length > RX_MAX) rx = ""
    }

    function foreignSerial(): void {
        serialForeign = true
        rx = ""
    }

    /**
     * One downlink line, from any pipe (mailbox, serial, BLE, simulator). The
     * same handling everywhere: there is no second dialect for any pipe.
     */
    export function handleLine(raw: string): void {
        if (!raw) return
        const line = trimEnd(raw)
        if (line.length < WIRE.length + 1 || line.substr(0, WIRE.length) != WIRE) return
        const kind = line.charAt(WIRE.length)
        const rest = line.length > WIRE.length + 2 ? line.substr(WIRE.length + 2, line.length - WIRE.length - 2) : ""
        if (kind == "?") {
            // Campus arrived later than the program (tab opened, page
            // reloaded): our announcement is long gone. Without an answer a
            // flashed device talks into the void until somebody opens the editor.
            iotcore.requestHello()
            return
        }
        if (kind == "t") {
            // Unix seconds. Older hosts append the zone with a colon.
            let secText = rest
            let tzo = NaN
            const p = rest.indexOf(":")
            if (p >= 0) {
                secText = rest.substr(0, p)
                tzo = parseFloat(rest.substr(p + 1, rest.length - p - 1))
            }
            const sec = parseFloat(secText)
            if (!(sec > 0)) return
            iotcore.setClock(sec, tzo)
            // Over WLAN the status belongs to the HTTP exchange.
            if (!iotcore.usesWlan()) iotcore.markConnected()
            return
        }
        if (kind == "z") {
            // May arrive before or after `t:`, so it only sets the offset.
            iotcore.setZone(parseFloat(rest))
            return
        }
        if (kind == "e") {
            iotcore.reportError(rest)
            return
        }
        if (kind == "v") {
            // Over WLAN the HTTP answer is the one downlink; a second source
            // would deliver every value twice.
            if (iotcore.usesWlan()) return
            // <from>:<to>:<feed>:<value…>, value last and may contain colons.
            const a = rest.indexOf(":")
            if (a < 0) return
            const b = rest.indexOf(":", a + 1)
            if (b < 0) return
            const c = rest.indexOf(":", b + 1)
            if (c < 0) return
            const from = rest.substr(0, a).trim()
            const to = rest.substr(a + 1, b - a - 1).trim()
            const feed = rest.substr(b + 1, c - b - 1)
            const value = rest.substr(c + 1, rest.length - c - 1)
            if (iotcore.feedKey(feed) == "") return
            iotcore.markConnected()
            iotcore.receive(feed, value, from, to)
        }
    }

    function trimEnd(s: string): string {
        let end = s.length
        while (end > 0) {
            const ch = s.charAt(end - 1)
            if (ch != "\r" && ch != "\n" && ch != " ") break
            end--
        }
        return end == s.length ? s : s.substr(0, end)
    }

    // ---- side channel (BLE) ----------------------------------------------

    /** See `iot.setzeZusatzKanal`. */
    export function setSideChannel(fn: (line: string) => void): void {
        sideChannel = fn
        iotcore.start()
    }
}

// Hooks the Campus-generated `iotble.ts` calls. Over BLE neither pipe reaches
// the host: the mailbox hangs on the USB debug port, and `serial` does not feed
// the Nordic UART service. The service does not belong here either: `bluetooth`
// is a compile-time dependency that would cost every program a BLE stack and
// clashes with `radio`. So it is inverted: Campus adds a file that starts the
// UART service and registers itself here. Names kept for that file.
//
// Line comments on purpose: a doc comment here would become part of the IoT
// category's description (pxt merges the docs of all `namespace iot` blocks).
namespace iot {
    /**
     * Register a second output that every IoT line also goes to (the BLE UART
     * service). There is one, because there is one case.
     */
    //% blockHidden=true
    export function setzeZusatzKanal(kanal: (zeile: string) => void): void {
        iotcampus.setSideChannel(kanal)
    }

    /** A line that came in another way (the BLE UART service); handled like every other. */
    //% blockHidden=true
    export function empfangeVonAussen(zeile: string): void {
        iotcampus.handleLine(zeile)
    }
}
