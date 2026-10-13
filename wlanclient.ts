/**
 * WLAN client (namespace iotwifi): brings the WiFi module up, keeps it joined,
 * and carries one ingest request per call.
 *
 * Sits on the C++ AT engine (wlanshims.ts, iotwlan.*): one transaction at a
 * time, URCs queued, length-framed payloads. This file owns everything above:
 *
 *  - ONE background fiber does bring-up, join and rejoin. State machine:
 *        OFF -> WAKING -> JOINING -> ONLINE -> LOST -> JOINING ...
 *    WIFI DISCONNECT sets LOST at once; rejoin backs off 1 s .. 30 s; a
 *    module reset ("ready", counted by the engine) re-runs the bring-up.
 *  - A module that answers nothing gets a recovery ladder before the client
 *    gives up with "no-module" (see recover()): the module keeps its power
 *    when the Calliope is reset or reflashed, so it may still wait for the
 *    data of a send that was cut off, or sit in transparent mode.
 *  - postIngest() is the sender the core calls from its own fiber (registered
 *    with iotcore.setWlanSender, before any UART is opened). It blocks for the
 *    whole HTTP exchange and is serialised against the fiber with `locked`:
 *    the engine would answer BUSY to a second caller, but a POST between a
 *    CWJAP and its result must not happen in the first place.
 *
 * Transport (decided per request from the URL and the module's capabilities):
 *    https without the TLS capability      -> error "tls", nothing is sent
 *    HTTP capability (ESP-AT >= 2.1)        -> AT+HTTPCPOST, body comes back framed
 *    otherwise, or after a truncated answer -> CIPSTART "TCP"/"SSL" + CIPSEND,
 *                                              passive pulls (CIPRECVDATA) or active +IPD
 *
 * Strings: calliopemini compiles with utf8=false, so strings are byte strings.
 * A source literal is stored as ONE byte per character (charCode & 0xff, i.e.
 * Latin-1 for U+0000..U+00FF), while text from outside (server JSON, serial)
 * arrives as UTF-8 bytes. Outgoing JSON therefore decodes valid UTF-8
 * sequences and treats any other byte >= 0x80 as Latin-1, and writes pure
 * ASCII with \uXXXX. Incoming text is turned into the literal form (one byte
 * for code points <= 0xFF, UTF-8 bytes above), so a feed key coming back from
 * the server equals the literal the program used.
 *
 * pxt Static TypeScript: no RegExp/Map/exceptions; NaN-safe comparisons.
 */
namespace iotwifi {
    // ---- states -------------------------------------------------------------
    export const OFF = 0
    export const WAKING = 1
    export const JOINING = 2
    export const ONLINE = 3
    export const LOST = 4

    // ---- engine constants (wlanshims.ts / wlanat.h) --------------------------
    // Results as plain numbers: the Node tests load this file without the
    // shims' const enum.
    const R_OK = 0
    const R_TIMEOUT = 3
    const R_BUSY = 4
    /** iotwlan.detect() capability flags */
    export const CAP_HTTP = 1
    export const CAP_PASSIVE = 2
    export const CAP_TLS = 4
    export const CAP_SYSSTORE = 8
    /** iotwlan.detect() families */
    export const FAMILY_AT1 = 1
    export const FAMILY_ESPAT = 2
    const RF_RESET = 2
    const RF_TRUNC = 4
    const U_GOT_IP = 3
    const U_WIFI_LOST = 4
    const U_IPD = 9
    /** iotwlan.status(): TCP/SSL link open */
    const ST_LINK = 4

    // ---- timing -------------------------------------------------------------
    const BAUD = 115200
    const JOIN_MS = 20000
    const BACKOFF_MIN = 1000
    const BACKOFF_MAX = 30000
    /** while online: how often AT+CWJAP? refreshes the RSSI and proves the module alive */
    const CHECK_MS = 30000
    const LOCK_MS = 3000
    const POST_MS = 15000
    const RECV_MS = 10000
    /** passive receive: bytes per AT+CIPRECVDATA */
    const PULL = 200
    /** AT+HTTPCPOST lines must stay under 256 bytes (else AT+HTTPURLCFG); longer -> TCP path */
    const MAX_CMD = 250
    /** recovery: filler that completes the largest pending send (CIPSEND max 8192 on ESP-AT) */
    const FILL_MAX = 8192 + 256
    /** recovery: silence around "+++" (ESP-AT: a packet of only "+++", then 1 s before the next command) */
    const GUARD_MS = 1100
    /** recovery: the whole ladder; with the first wake (3 s) a bring-up attempt stays near 15 s */
    const RECOVER_MS = 12000
    const READY_MS = 3000

    // ---- state ------------------------------------------------------------
    let st = OFF
    let started = false
    let portOpen = false
    let locked = false
    let ssid = ""
    let pass = ""
    let txPin = 0
    let rxPin = 0
    let lastErr = ""
    let caps = 0
    let family = 0
    let version = ""
    let chip = ""
    let passive = false
    let rssiDbm = 0
    let backoff = BACKOFF_MIN
    let nextTry = 0
    /** engine reset counter (iotwlan.stats(1)) last seen */
    let resets = 0
    let lastCheck = 0
    let missed = 0
    /** passive receive: a "+IPD,<len>" notification arrived since the request went out */
    let ipdSeen = false
    let tcpOnly = false
    /** requests left that skip HTTPCPOST because its answer did not fit the engine's buffer */
    let rawLeft = 0
    let url: Url = null
    /** engine reset counter at the start of the running bring-up (a reset of our own updates it) */
    let bootResets = 0
    /** 256 bytes of CRLF, built on first use */
    let fill = ""
    let recRung = ""
    let recRuns = 0
    let recBytes = 0
    let recMs = 0
    let recBusy = false

    // =========================================================================
    // Public API
    // =========================================================================

    /**
     * Start WiFi: store the credentials, register the ingest sender with the
     * core and start the background fiber. Returns at once; the UART opens
     * at 5 s uptime at the earliest (iotwlan.begin enforces it).
     * Calling it again with other credentials rejoins.
     */
    export function connect(ssidText: string, password: string, tx: SerialPin, rx: SerialPin): void {
        const changed = ssidText != ssid || password != pass
        ssid = ssidText
        pass = password
        txPin = tx
        rxPin = rx
        // before the fiber can open (or redirect) a UART: from now on the core
        // leaves USB serial alone
        iotcore.setWlanSender(postIngest)
        if (!started) {
            started = true
            st = WAKING
            control.inBackground(fiber)
        } else if (changed && (st == ONLINE || st == LOST)) {
            st = JOINING
            nextTry = 0
            backoff = BACKOFF_MIN
        }
    }

    /** Block until online or `timeoutMs` passed. */
    export function waitOnline(timeoutMs: number): boolean {
        const start = control.millis()
        while (st != ONLINE) {
            if (!(control.millis() - start < timeoutMs)) return false
            basic.pause(50)
        }
        return true
    }

    export function isOnline(): boolean {
        return st == ONLINE
    }

    /** OFF 0, WAKING 1, JOINING 2, ONLINE 3, LOST 4 */
    export function state(): number {
        return st
    }

    export function stateText(): string {
        if (st == WAKING) return "waking"
        if (st == JOINING) return "joining"
        if (st == ONLINE) return "online"
        if (st == LOST) return "lost"
        return "off"
    }

    /**
     * The most recent problem, kept after recovery ("" if none so far):
     * "uart-<n>" (begin failed), "no-module", "module-reset", "module-busy",
     * "wrong-password", "ap-not-found", "join-timeout", "join-failed", "wifi-lost".
     */
    export function lastError(): string {
        return lastErr
    }

    /** 0 unknown, 1 AT 1.x (ESP8266/ESP8285), 2 ESP-AT >= 2 */
    export function moduleFamily(): number {
        return family
    }

    /** AT version from AT+GMR, e.g. "3.3.0.0" */
    export function moduleVersion(): string {
        return version
    }

    /** chip from AT+GMR, e.g. "ESP32C3" ("" on AT 1.x) */
    export function moduleChip(): string {
        return chip
    }

    /** CAP_* flags of the module */
    export function capabilities(): number {
        return caps
    }

    /** true if the module accepted AT+CIPRECVMODE=1 */
    export function passiveReceive(): boolean {
        return passive
    }

    /** Signal strength in dBm from the last AT+CWJAP? (0 = not measured yet). */
    export function rssi(): number {
        return rssiDbm
    }

    /**
     * Outcome of the last recovery of a silent module: "" never needed,
     * "filler" (a cut-off send was completed), "+++" (left transparent mode),
     * "reset" (AT+RST), "none" (nothing helped: lastError() is "no-module").
     */
    export function recoveryRung(): string {
        return recRung
    }

    /** How often the recovery ladder ran since connect(). */
    export function recoveryRuns(): number {
        return recRuns
    }

    /**
     * Bytes the module sent during the last recovery. With "none": 0 means
     * silent (crashed, unpowered, wrong pins); > 0 means alive but not
     * answering AT (boot loop, wrong baud rate).
     */
    export function recoveryBytes(): number {
        return recBytes
    }

    /** Duration of the last recovery in ms. */
    export function recoveryMs(): number {
        return recMs
    }

    /** Diagnosis: send over CIPSTART/CIPSEND even when AT+HTTPCPOST is available. */
    export function preferTcp(on: boolean): void {
        tcpOnly = on
    }

    // =========================================================================
    // Background fiber
    // =========================================================================

    function fiber(): void {
        while (true) basic.pause(step())
    }

    /**
     * One turn of the background fiber; returns the milliseconds until the
     * next turn. Exported for the Node tests, which drive it with a fake clock.
     */
    export function step(): number {
        if (st == OFF) return 1000
        if (!portOpen) {
            const r = iotwlan.begin(txPin, rxPin, BAUD)
            if (r < 0) {
                lastErr = "uart" + r
                return BACKOFF_MAX
            }
            portOpen = true
            resets = iotwlan.stats(1)
        }
        if (locked) return 50 // a POST is running
        checkReset()
        pollUrcs()
        const now = control.millis()
        if (st == ONLINE) {
            if (!(now - lastCheck < CHECK_MS)) {
                locked = true
                checkLink()
                locked = false
                lastCheck = control.millis()
            }
            return 200
        }
        if (now < nextTry) {
            const w = nextTry - now
            return w < 200 ? w : 200
        }
        locked = true
        bootResets = iotwlan.stats(1)
        let ok = true
        if (st == WAKING) ok = bringUp()
        if (ok) {
            st = JOINING
            ok = join()
        }
        // A join of a connected module prints WIFI DISCONNECT before the new
        // WIFI CONNECTED; those URCs are history once the join answered.
        while (iotwlan.takeUrc() > 0) { }
        locked = false
        if (iotwlan.stats(1) != bootResets) {
            resets = iotwlan.stats(1)
            st = WAKING
            lastErr = "module-reset"
            ok = false
        }
        if (ok) {
            st = ONLINE
            backoff = BACKOFF_MIN
            missed = 0
            lastCheck = control.millis()
            return 200
        }
        nextTry = control.millis() + backoff
        backoff = backoff * 2 < BACKOFF_MAX ? backoff * 2 : BACKOFF_MAX
        return 200
    }

    /** The module rebooted (engine counter moved): run the bring-up again. */
    function checkReset(): boolean {
        const n = iotwlan.stats(1)
        if (n == resets) return false
        resets = n
        if (st != OFF) {
            st = WAKING
            lastErr = "module-reset"
            nextTry = 0
            backoff = BACKOFF_MIN
        }
        return true
    }

    function pollUrcs(): void {
        while (true) {
            const u = iotwlan.takeUrc()
            if (u <= 0) return
            const k = u & 255
            if (k == U_WIFI_LOST) {
                if (st == ONLINE) lose()
            } else if (k == U_GOT_IP) {
                // the module reconnected by itself: check now instead of after the backoff
                if (st == LOST || st == JOINING) nextTry = 0
            } else if (k == U_IPD) {
                ipdSeen = true
            }
        }
    }

    function lose(): void {
        st = LOST
        lastErr = "wifi-lost"
        backoff = BACKOFF_MIN
        nextTry = control.millis() + BACKOFF_MIN
    }

    function bringUp(): boolean {
        const busy0 = iotwlan.stats(2)
        if (!iotwlan.wake(6, 500)) {
            if (iotwlan.stats(2) != busy0) {
                // "busy p...": alive and still working on something; try again later
                lastErr = "module-busy"
                return false
            }
            if (!recover()) {
                lastErr = recBusy ? "module-busy" : "no-module"
                return false
            }
        }
        iotwlan.echoOff(1000)
        const d = iotwlan.detect(2000)
        caps = d & 255
        family = (d >> 8) & 255
        version = iotwlan.moduleInfo(0)
        chip = iotwlan.moduleInfo(1)
        const at1 = family == FAMILY_AT1
        // ESP-AT: nothing after this writes the module's flash
        if ((caps & CAP_SYSSTORE) != 0) iotwlan.command("AT+SYSSTORE=0", 1000)
        // AT 1.x: the plain command is _DEF and writes flash
        if (at1 || iotwlan.command("AT+CWMODE=1", 2000) != R_OK) iotwlan.command("AT+CWMODE_CUR=1", 2000)
        // a link left from before a reset of the Calliope, and transparent
        // mode set by an earlier program: neither may outlive the bring-up
        iotwlan.command("AT+CIPCLOSE", 1000)
        iotwlan.command("AT+CIPMUX=0", 1000)
        iotwlan.command("AT+CIPMODE=0", 1000)
        iotwlan.command("AT+CIPDINFO=0", 1000)
        // "ERR CODE:0x..." lines tell the HTTP status of a failed HTTPCPOST
        if (family == FAMILY_ESPAT) iotwlan.command("AT+SYSLOG=1", 1000)
        // Probed, not assumed: ESP-AT has it, AT 1.7 may, AT 1.6 answers ERROR.
        passive = iotwlan.command("AT+CIPRECVMODE=1", 1000) == R_OK
        return true
    }

    // ---- recovery of a silent module -------------------------------------

    function filler(): string {
        if (fill.length == 0) {
            fill = "\r\n"
            for (let i = 0; i < 7; i++) fill += fill // 256 bytes
        }
        return fill
    }

    /** "AT" until OK. A "busy p..." try does not count (alive, working) until `until`. */
    function revive(tries: number, until: number): boolean {
        let left = tries
        while (left > 0) {
            const b = iotwlan.stats(2)
            if (iotwlan.command("AT", 500) == R_OK) return true
            if (iotwlan.stats(2) != b) recBusy = true
            if (iotwlan.stats(2) == b || !(control.millis() < until)) left--
        }
        return false
    }

    /**
     * The module answered nothing to "AT". It keeps its power when the
     * Calliope is reset or reflashed, so it can be stuck in a state the new
     * program knows nothing about. Rungs, likeliest and cheapest first:
     *  (a) It still waits for the data of an AT+CIPSEND=<n> / AT+HTTPCPOST
     *      whose sender was reset after the '>' (observed: five days silent).
     *      Every byte, "AT\r\n" included, is swallowed as payload until n
     *      arrived. CRLF filler completes it: it contains no "AT", so the
     *      payload becomes harmless garbage (the server answers 400) and any
     *      excess is empty lines. 256 bytes at a time, stopping at the first
     *      byte the module sends back ("Recv <n> bytes", SEND OK/FAIL, busy);
     *      at most 8448 bytes, about 0.75 s at 115200 baud.
     *  (b) Transparent mode (AT+CIPMODE=1 + AT+CIPSEND): left only on a lone
     *      "+++" with silence before and after.
     *  (c) Only if the module sent anything at all during (a)/(b): alive but
     *      deaf to AT (stuck command, error state): AT+RST, wait for "ready".
     *      A module that sent nothing would not hear AT+RST either.
     * Not tried: other baud rates. The client never changes the module's rate
     * (no AT+UART_*), and a rate stored in the module's flash would survive a
     * power cycle too, unlike what was observed. A module at a wrong rate
     * shows up as recoveryBytes() > 0 with "none".
     * Bounded by RECOVER_MS: about 6.5 s for a silent module, 12 s with (c).
     */
    function recover(): boolean {
        recRuns++
        recBusy = false
        const start = control.millis()
        const until = start + RECOVER_MS
        const rx0 = iotwlan.stats(9)
        let rung = "none"
        // (a) complete a cut-off send
        let sent = 0
        while (sent < FILL_MAX && iotwlan.stats(9) == rx0) {
            if (!iotwlan.writeRaw(filler())) break
            sent += 256
            iotwlan.pumpFor(5)
        }
        iotwlan.pumpFor(300)
        while (iotwlan.takeUrc() > 0) { }
        if (revive(3, until)) rung = "filler"
        // (b) transparent mode
        if (rung == "none" && control.millis() < until) {
            iotwlan.pumpFor(GUARD_MS)
            iotwlan.writeRaw("+++")
            iotwlan.pumpFor(GUARD_MS)
            if (revive(3, until)) rung = "+++"
        }
        // (c) alive but deaf to AT: reset
        if (rung == "none" && iotwlan.stats(9) != rx0 && control.millis() < until) {
            const r0 = iotwlan.stats(1)
            iotwlan.command("AT+RST", 1000)
            const t = control.millis()
            while (iotwlan.stats(1) == r0 && control.millis() - t < READY_MS) iotwlan.pumpFor(50)
            if (revive(3, until)) rung = "reset"
        }
        while (iotwlan.takeUrc() > 0) { }
        // a reset of our own is no "module-reset" of the bring-up
        resets = iotwlan.stats(1)
        bootResets = resets
        recRung = rung
        recBytes = iotwlan.stats(9) - rx0
        recMs = control.millis() - start
        return rung != "none"
    }

    /**
     * A send timed out (no SEND OK). The module may still wait for (part of)
     * its data (a late '>', lost bytes) and would swallow the next commands.
     * n filler bytes complete it; if it was not waiting, they are empty
     * lines. Keeps the client from ever leaving the module wedged.
     */
    function unwedge(n: number): void {
        const f = filler()
        let left = n + (n & 1) // whole CRLF pairs: no lone CR before the next command
        while (left > 0) {
            if (!iotwlan.writeRaw(left >= f.length ? f : f.substr(0, left))) return
            left -= f.length
        }
        iotwlan.pumpFor(200)
    }

    function join(): boolean {
        const want = toUtf8(ssid)
        if (joinedTo(want)) {
            readRssi()
            return true
        }
        const cmd = (family == FAMILY_AT1 ? "AT+CWJAP_CUR=\"" : "AT+CWJAP=\"") +
            atEscape(want) + "\",\"" + atEscape(toUtf8(pass)) + "\""
        const r = iotwlan.command(cmd, JOIN_MS)
        if (r == R_OK) {
            readRssi()
            return true
        }
        lastErr = joinError(r)
        return false
    }

    /** ESP-AT: +CWJAP:<n> then ERROR; AT 1.x: +CWJAP_CUR:<n> then FAIL. */
    function joinError(r: number): string {
        if ((iotwlan.resultFlags() & RF_RESET) != 0) return "module-reset"
        if (r == R_TIMEOUT) return "join-timeout"
        if (r == R_BUSY) return "module-busy"
        const l = iotwlan.findLine("+CWJAP")
        const c = l.indexOf(":")
        const code = c < 0 ? -1 : digits(l, c + 1)
        if (code == 1) return "join-timeout"
        if (code == 2) return "wrong-password"
        if (code == 3) return "ap-not-found"
        return "join-failed"
    }

    /** Is the module already on `want` with an address? Then the join is skipped. */
    function joinedTo(want: string): boolean {
        if ((caps & CAP_SYSSTORE) != 0) {
            if (iotwlan.command("AT+CWSTATE?", 2000) != R_OK) return false
            // +CWSTATE:<state>,"<ssid>"   state 2: connected with an IPv4 address
            const l = iotwlan.findLine("+CWSTATE:")
            const q = l.indexOf("\"")
            let e = l.length - 1
            while (e > q && l.charCodeAt(e) != 34) e--
            return l.charCodeAt(9) == 50 && q > 0 && e > q && l.substr(q + 1, e - q - 1) == want
        }
        const at1 = family == FAMILY_AT1
        if (iotwlan.command(at1 ? "AT+CWJAP_CUR?" : "AT+CWJAP?", 2000) != R_OK) return false
        const l = iotwlan.findLine(at1 ? "+CWJAP_CUR:" : "+CWJAP:")
        const m = bssidAt(l)
        const q = l.indexOf("\"")
        if (m < 0 || l.substr(q + 1, m - q - 1) != want) return false
        if (iotwlan.command("AT+CIPSTATUS", 2000) != R_OK) return false
        // STATUS:2 got IP, 3 link up, 4 link closed — all with an address
        const c = iotwlan.findLine("STATUS:").charCodeAt(7)
        return c >= 50 && c <= 52
    }

    /** AT+CWJAP? -> 1 connected (RSSI updated), 0 not connected, -1 no answer. */
    function readRssi(): number {
        const at1 = family == FAMILY_AT1
        const r = iotwlan.command(at1 ? "AT+CWJAP_CUR?" : "AT+CWJAP?", 2000)
        if (r == R_TIMEOUT) return -1
        if (r != R_OK) return 1 // busy or unsupported: no verdict
        const l = iotwlan.findLine(at1 ? "+CWJAP_CUR:" : "+CWJAP:")
        if (l.length == 0) return 0 // "No AP"
        if (bssidAt(l) >= 0) rssiDbm = rssiOf(l)
        return 1
    }

    function checkLink(): void {
        const r = readRssi()
        if (r == 0) {
            lose()
        } else if (r < 0) {
            missed++
            if (missed >= 2) {
                st = WAKING
                lastErr = "no-module"
                nextTry = 0
                backoff = BACKOFF_MIN
                missed = 0
            }
        } else {
            missed = 0
        }
    }

    /**
     * Index of the `","` before the BSSID in a +CWJAP(_CUR) line, -1 if none.
     *   +CWJAP:"<ssid>","aa:bb:cc:dd:ee:ff",<ch>,<rssi>,...
     * Found by the MAC's shape, so an SSID containing `","` cannot fool it.
     */
    function bssidAt(l: string): number {
        let i = l.indexOf("\",\"")
        while (i >= 0) {
            const b = i + 3
            if (l.charCodeAt(b + 2) == 58 && l.charCodeAt(b + 14) == 58 &&
                l.charCodeAt(b + 17) == 34 && l.charCodeAt(b + 18) == 44) return i
            i = l.indexOf("\",\"", i + 1)
        }
        return -1
    }

    function rssiOf(l: string): number {
        let p = bssidAt(l) + 22 // after `","` + 17 MAC chars + `",`
        while (p < l.length && l.charCodeAt(p) != 44) p++ // channel
        p++
        const neg = l.charCodeAt(p) == 45
        const v = digits(l, neg ? p + 1 : p)
        return v < 0 ? 0 : neg ? -v : v
    }

    // =========================================================================
    // Ingest
    // =========================================================================

    /**
     * One ingest request. Blocking; called from the core's sender fiber, never
     * concurrently with itself. Does not modify `batch` or `ctx`.
     * Answer.error when !ok: the server's `error` code, or one of
     *   "offline" "busy" "tls" "too-big" "bad-url" "timeout" "connect" "dns"
     *   "send" "reset" "wifi" "bad-answer" "http-<status>"
     */
    export function postIngest(batch: iotcore.Batch, ctx: iotcore.IngestContext): iotcore.Answer {
        const a = new iotcore.Answer()
        if (portOpen) {
            checkReset()
            pollUrcs()
        }
        if (st != ONLINE) {
            a.error = "offline"
            return a
        }
        if (!url || url.src != ctx.server) url = new Url(ctx.server)
        const u = url
        if (u.host.length == 0) {
            a.error = "bad-url"
            return a
        }
        if (u.tls && (caps & CAP_TLS) == 0) {
            a.error = "tls"
            return a
        }
        const body = buildBody(batch, ctx)
        let cmd = ""
        let req = ""
        if ((caps & CAP_HTTP) != 0 && !tcpOnly && !(rawLeft > 0)) {
            cmd = "AT+HTTPCPOST=\"" + u.url + "\"," + body.length + ",1,\"Content-Type: application/json\""
            if (cmd.length > MAX_CMD) cmd = ""
        }
        if (cmd.length == 0) req = httpRequest(u, body)
        if ((cmd.length > 0 ? body.length : req.length) > maxSend()) {
            a.error = "too-big"
            return a
        }
        if (rawLeft > 0) rawLeft--
        if (!lock()) {
            a.error = "busy"
            return a
        }
        const r0 = iotwlan.stats(1)
        const answered = cmd.length > 0 ? postHttpc(cmd, body, a) : postRaw(u, req, a)
        locked = false
        const reset = iotwlan.stats(1) != r0
        checkReset()
        pollUrcs()
        if (!a.ok && !answered) {
            if (reset) a.error = "reset"
            else if (st != ONLINE) a.error = "wifi"
        }
        return a
    }

    function lock(): boolean {
        const start = control.millis()
        while (locked) {
            if (!(control.millis() - start < LOCK_MS)) return false
            basic.pause(10)
        }
        locked = true
        return true
    }

    /** CIPSEND maximum: 8192 on ESP-AT >= 2 (not on an ESP8266), 2048 on AT 1.x. */
    function maxSend(): number {
        return family == FAMILY_ESPAT && chip.indexOf("ESP8266") < 0 ? 8192 : 2048
    }

    /** {"t","dev","now","boot","s","scope","since","n":{key:label},"d":[{"f","v","dt","to"}]} */
    function buildBody(b: iotcore.Batch, c: iotcore.IngestContext): string {
        let s = "{\"t\":" + jsonQuote(c.ref) + ",\"dev\":" + jsonQuote(c.dev) +
            ",\"now\":" + control.millis() + ",\"boot\":" + jsonQuote(c.boot) +
            ",\"s\":" + b.seq + ",\"scope\":" + jsonQuote(c.scope) + ",\"since\":" + c.since
        if (b.labelKeys.length > 0) {
            s += ",\"n\":{"
            for (let i = 0; i < b.labelKeys.length; i++) {
                if (i > 0) s += ","
                s += jsonQuote(b.labelKeys[i]) + ":" + jsonQuote(b.labelTexts[i] || "")
            }
            s += "}"
        }
        s += ",\"d\":["
        for (let i = 0; i < b.feeds.length; i++) {
            const v = b.values[i]
            const age = b.ages[i]
            s += (i > 0 ? ",{\"f\":" : "{\"f\":") + jsonQuote(b.feeds[i]) +
                ",\"v\":" + (v && v.length > 0 ? v : "\"\"") +
                ",\"dt\":" + (age > 0 ? -Math.round(age) : 0) +
                ",\"to\":" + jsonQuote(b.tos[i] || "") + "}"
        }
        return s + "]}"
    }

    function httpRequest(u: Url, body: string): string {
        return "POST " + u.path + "/ingest HTTP/1.1\r\nHost: " + u.hostHeader +
            "\r\nContent-Type: application/json\r\nContent-Length: " + body.length +
            "\r\nConnection: close\r\n\r\n" + body
    }

    /**
     * AT+HTTPCPOST. The body comes back length-framed (+HTTPCPOST:<n>,<data>),
     * without status line. ESP-AT does not document what happens on 4xx/5xx;
     * handled: a framed error body with SEND OK, SEND FAIL or ERROR (the body
     * decides), no body with "ERR CODE:0x010a7<status>" (AT+SYSLOG=1), and a
     * bare SEND FAIL. Returns true if the server's answer was read.
     */
    function postHttpc(cmd: string, body: string, a: iotcore.Answer): boolean {
        const r = iotwlan.sendData(cmd, body, POST_MS)
        const flags = iotwlan.resultFlags()
        const text = iotwlan.payloadLength() > 0 ? payloadText() : ""
        const code = errCode()
        // never leave the module waiting for data (results stay readable: unwedge runs no command)
        if (r == R_TIMEOUT && (flags & RF_RESET) == 0) unwedge(body.length)
        if (text.length > 0) {
            let shape = parseAnswer(text, a)
            if ((flags & RF_TRUNC) != 0) {
                // longer than the engine's payload buffer: frames were dropped.
                // The TCP path has no such bound; use it for the next requests.
                shape = 1
                rawLeft = 3
            }
            settle(shape, a)
            if (!a.ok && a.error == "bad-answer" && code > 0) a.error = "http-" + code
            return shape >= 0
        }
        if ((flags & RF_RESET) != 0) a.error = "reset"
        else if (r == R_TIMEOUT) a.error = "timeout"
        else if (r == R_BUSY) a.error = "busy"
        else if (r == R_OK) a.error = "bad-answer"
        else a.error = code > 0 ? "http-" + code : code == 0 ? "connect" : "send"
        return false
    }

    /** Status from "ERR CODE:0x010a7xxx": 0x7000 + HTTP status; 0 = no connection, -1 = none. */
    function errCode(): number {
        const l = iotwlan.findLine("ERR CODE:0x")
        if (l.length < 15) return -1
        const v = hexAt(l, l.length - 4)
        if (v < 0x7000 || v > 0x7fff) return -1
        return v - 0x7000
    }

    /** Raw HTTP/1.1 over CIPSTART + CIPSEND. Returns true if an HTTP status line came back. */
    function postRaw(u: Url, req: string, a: iotcore.Answer): boolean {
        closeLink()
        while (iotwlan.recvAvailable() > 0) iotwlan.recvTake(2048) // leftovers of an earlier link
        if (u.tls && family == FAMILY_ESPAT) iotwlan.command("AT+CIPSSLCSNI=\"" + atEscape(u.host) + "\"", 1000)
        ipdSeen = false
        let r = iotwlan.command("AT+CIPSTART=\"" + (u.tls ? "SSL" : "TCP") + "\",\"" + atEscape(u.host) + "\"," + u.port,
            u.tls ? POST_MS : RECV_MS)
        if (r != R_OK) {
            a.error = r == R_TIMEOUT ? "timeout" : iotwlan.findLine("DNS").length > 0 ? "dns" : "connect"
            closeLink()
            return false
        }
        r = iotwlan.sendData("AT+CIPSEND=" + req.length, req, 5000)
        if (r != R_OK) {
            if (r == R_TIMEOUT && (iotwlan.resultFlags() & RF_RESET) == 0) unwedge(req.length)
            a.error = r == R_TIMEOUT ? "timeout" : "send"
            closeLink()
            return false
        }
        const resp = passive ? pullPassive() : pullActive()
        closeLink()
        return parseHttp(resp, a)
    }

    function closeLink(): void {
        if ((iotwlan.status() & ST_LINK) != 0 || iotwlan.stats(0) > 0) iotwlan.command("AT+CIPCLOSE", 2000)
    }

    /**
     * Passive receive: pull while the module announces data. After each
     * partial pull it re-announces the REMAINING total (+IPD,462 -> 262 -> 62),
     * which the engine's stats(0) follows. Ends when Content-Length is
     * satisfied or the link is closed and drained (ESP-AT withholds CLOSED
     * until the buffer is read).
     */
    function pullPassive(): string {
        let resp = ""
        const start = control.millis()
        let lastTry = false
        while (control.millis() - start < RECV_MS) {
            pollUrcs()
            if (ipdSeen && iotwlan.stats(0) > 0) {
                if (iotwlan.command("AT+CIPRECVDATA=" + PULL, 2000) == R_OK && iotwlan.payloadLength() > 0) resp += payloadText()
                else ipdSeen = false // nothing there after all: wait for the next notification
                continue
            }
            if (httpDone(resp)) break
            if ((iotwlan.status() & ST_LINK) == 0) {
                // closed; one more pull covers a lost notification
                if (lastTry) break
                lastTry = true
                if (iotwlan.command("AT+CIPRECVDATA=" + PULL, 1000) == R_OK && iotwlan.payloadLength() > 0) {
                    resp += payloadText()
                    lastTry = false
                }
                continue
            }
            iotwlan.pumpFor(10)
        }
        return resp
    }

    /** Active receive (+IPD,<len>:<data> buffered by the engine). CLOSED follows the last frame. */
    function pullActive(): string {
        let resp = ""
        const start = control.millis()
        while (control.millis() - start < RECV_MS) {
            pollUrcs()
            if (iotwlan.recvAvailable() > 0) {
                resp += iotwlan.recvTake(2048)
                continue
            }
            if (httpDone(resp)) break
            if ((iotwlan.status() & ST_LINK) == 0) break
            iotwlan.waitRecv(1, 50)
        }
        return resp
    }

    function payloadText(): string {
        const n = iotwlan.payloadLength()
        let s = ""
        while (s.length < n) {
            const part = iotwlan.payload(s.length, n - s.length)
            if (part.length == 0) break
            s += part
        }
        return s
    }

    function httpDone(resp: string): boolean {
        const he = resp.indexOf("\r\n\r\n")
        if (he < 0) return false
        const v = headerAt(resp, he, "content-length")
        if (v < 0) return false // no length: the end is the link closing (Connection: close)
        const len = digits(resp, v)
        return len >= 0 && resp.length - he - 4 >= len
    }

    /** Status line, headers, body (Content-Length or chunked). True if it was HTTP at all. */
    function parseHttp(resp: string, a: iotcore.Answer): boolean {
        if (resp.length == 0) {
            a.error = "timeout"
            return false
        }
        if (resp.indexOf("HTTP/") != 0) {
            a.error = "bad-answer"
            return false
        }
        const status = digits(resp, resp.indexOf(" ") + 1)
        const he = resp.indexOf("\r\n\r\n")
        let body = he < 0 ? "" : resp.substr(he + 4)
        if (he >= 0) {
            const te = headerAt(resp, he, "transfer-encoding")
            if (te >= 0 && (resp.charCodeAt(te) | 32) == 99) body = dechunk(body) // "chunked"
        }
        const shape = parseAnswer(body, a)
        if (status >= 200 && status < 300) {
            settle(shape, a)
            return true
        }
        a.ok = false
        a.dup = false
        dropRows(a)
        a.cur = -1
        a.more = false
        if (a.error == "") a.error = "http-" + status
        if (status == 429 && !(a.retryAfterMs > 0) && he >= 0) {
            const ra = headerAt(resp, he, "retry-after")
            const sec = ra < 0 ? -1 : digits(resp, ra)
            if (sec > 0) a.retryAfterMs = sec * 1000
        }
        return true
    }

    /**
     * After parsing a 2xx (or framed) answer. A body that did not end cleanly
     * (cut by a buffer bound or a timeout) keeps `ok` — the batch WAS written —
     * but its rows and cursor cannot be trusted: none are reported, `more`
     * makes the core ask again at once.
     */
    function settle(shape: number, a: iotcore.Answer): void {
        if (shape != 0) {
            dropRows(a)
            a.cur = -1
            if (a.ok) a.more = true
        }
        if (a.ok) a.error = ""
        else if (a.error == "") a.error = jsonStatus >= 400 ? "http-" + jsonStatus : "bad-answer"
    }

    function dropRows(a: iotcore.Answer): void {
        a.dFeeds = []
        a.dValues = []
        a.dFroms = []
        a.dTos = []
    }

    /** Value start of header `name` (lowercase) in resp[0, end), -1 if absent. */
    function headerAt(resp: string, end: number, name: string): number {
        let p = resp.indexOf("\r\n") + 2
        while (p > 1 && p < end) {
            let k = 0
            while (k < name.length && (resp.charCodeAt(p + k) | 32) == name.charCodeAt(k)) k++
            if (k == name.length && resp.charCodeAt(p + k) == 58) {
                p += k + 1
                while (resp.charCodeAt(p) == 32) p++
                return p
            }
            const e = resp.indexOf("\r\n", p)
            if (e < 0) return -1
            p = e + 2
        }
        return -1
    }

    function dechunk(body: string): string {
        let out = ""
        let p = 0
        while (p < body.length) {
            const eol = body.indexOf("\r\n", p)
            if (eol < 0) break
            let size = 0
            let i = p
            while (i < eol) {
                const h = hexDigit(body.charCodeAt(i))
                if (h < 0) break
                size = size * 16 + h
                i++
            }
            if (i == p || size == 0) break
            out += body.substr(eol + 2, size)
            p = eol + 2 + size + 2
        }
        return out
    }

    // ---- URL ----------------------------------------------------------------

    class Url {
        src: string
        tls: boolean
        host: string
        port: number
        /** host, plus ":port" when not the default */
        hostHeader: string
        /** "/api/iot/v1", no trailing slash */
        path: string
        /** full ingest URL for AT+HTTPCPOST */
        url: string

        constructor(server: string) {
            this.src = server
            let s = server
            const i = s.indexOf("://")
            this.tls = false
            if (i >= 0) {
                const scheme = s.substr(0, i)
                this.tls = scheme == "https" || scheme == "HTTPS"
                s = s.substr(i + 3)
            }
            const slash = s.indexOf("/")
            let hp = slash < 0 ? s : s.substr(0, slash)
            let path = slash < 0 ? "" : s.substr(slash)
            while (path.length > 0 && path.charCodeAt(path.length - 1) == 47) path = path.substr(0, path.length - 1)
            if (path.length == 0) path = "/api/iot/v1"
            const def = this.tls ? 443 : 80
            this.port = def
            const colon = hp.indexOf(":")
            if (colon >= 0) {
                const p = digits(hp, colon + 1)
                if (p > 0) this.port = p
                hp = hp.substr(0, colon)
            }
            this.host = hp
            this.hostHeader = this.port == def ? hp : hp + ":" + this.port
            this.path = path
            this.url = (this.tls ? "https://" : "http://") + this.hostHeader + path + "/ingest"
        }
    }

    // =========================================================================
    // JSON
    // =========================================================================

    /** HTTP status from a PocketBase error body ({"status":404,...}); NaN if none. */
    let jsonStatus = NaN

    /**
     * Read an ingest answer into `a`. Keys in any order; unknown keys (also
     * nested objects/arrays) are skipped. Returns 0 for a complete object,
     * 1 for one that ends early or is malformed (what was read is kept),
     * -1 if the text is no object at all.
     */
    export function parseAnswer(text: string, a: iotcore.Answer): number {
        jsonStatus = NaN
        const r = new Reader(text)
        if (r.peek() != 123) return -1
        r.p++
        if (r.peek() == 125) return 0
        while (true) {
            if (r.peek() != 34) return 1
            const ks = r.p + 1
            if (!r.skipString()) return 1
            const ke = r.p - 1
            if (r.peek() != 58) return 1
            r.p++
            const c = r.peek()
            if (c < 0) return 1
            if (r.key(ks, ke, "w")) {
                if (!readRows(r, a)) return 1
            } else if (r.key(ks, ke, "error")) {
                if (c == 34) a.error = r.readString(false)
                else r.skipValue()
            } else if (c == 34 || c == 123 || c == 91) {
                r.skipValue()
            } else {
                const v = r.number()
                if (r.key(ks, ke, "ok")) a.ok = v == 1
                else if (r.key(ks, ke, "dup")) a.dup = v == 1
                else if (r.key(ks, ke, "retry_after")) a.retryAfterMs = v > 0 ? Math.round(v * 1000) : 0
                else if (r.key(ks, ke, "ts")) a.serverSec = v
                else if (r.key(ks, ke, "tzo")) a.tzoMin = v
                else if (r.key(ks, ke, "cur")) a.cur = v >= 0 ? v : -1
                else if (r.key(ks, ke, "more")) a.more = v == 1
                else if (r.key(ks, ke, "status")) jsonStatus = v
            }
            if (r.bad) return 1
            const d = r.peek()
            if (d == 44) {
                r.p++
                continue
            }
            return d == 125 ? 0 : 1
        }
    }

    /** `w`: [{"f","v","from","to"}, ...] -> the Answer's parallel arrays, in order. */
    function readRows(r: Reader, a: iotcore.Answer): boolean {
        if (r.peek() != 91) return r.skipValue()
        r.p++
        if (r.peek() == 93) {
            r.p++
            return true
        }
        while (true) {
            if (r.peek() != 123) return false
            r.p++
            let f = ""
            let v = "null"
            let from = ""
            let to = ""
            let hasF = false
            if (r.peek() == 125) r.p++
            else while (true) {
                if (r.peek() != 34) return false
                const ks = r.p + 1
                if (!r.skipString()) return false
                const ke = r.p - 1
                if (r.peek() != 58) return false
                r.p++
                if (r.key(ks, ke, "f")) {
                    f = r.text()
                    hasF = true
                } else if (r.key(ks, ke, "v")) v = r.literal()
                else if (r.key(ks, ke, "from")) from = r.text()
                else if (r.key(ks, ke, "to")) to = r.text()
                else r.skipValue()
                if (r.bad) return false
                const d = r.peek()
                if (d == 44) {
                    r.p++
                    continue
                }
                if (d != 125) return false
                r.p++
                break
            }
            if (hasF) {
                a.dFeeds.push(f)
                a.dValues.push(v)
                a.dFroms.push(from)
                a.dTos.push(to)
            }
            const e = r.peek()
            if (e == 44) {
                r.p++
                continue
            }
            if (e != 93) return false
            r.p++
            return true
        }
    }

    /** Cursor over a JSON text. Index-based; substrings only for values it returns. */
    class Reader {
        s: string
        p: number
        n: number
        /** ran out of text or met something malformed */
        bad: boolean

        constructor(s: string) {
            this.s = s
            this.p = 0
            this.n = s.length
            this.bad = false
        }

        /** Next non-blank char code (not consumed), -1 at the end. */
        peek(): number {
            while (this.p < this.n) {
                const c = this.s.charCodeAt(this.p)
                if (c != 32 && c != 10 && c != 13 && c != 9) return c
                this.p++
            }
            return -1
        }

        /** Is s[from, to) the key `k`? (server keys carry no escapes) */
        key(from: number, to: number, k: string): boolean {
            if (to - from != k.length) return false
            for (let i = 0; i < k.length; i++) {
                if (this.s.charCodeAt(from + i) != k.charCodeAt(i)) return false
            }
            return true
        }

        /** At '"': move past the closing quote. */
        skipString(): boolean {
            let i = this.p + 1
            while (i < this.n) {
                const c = this.s.charCodeAt(i)
                if (c == 34) {
                    this.p = i + 1
                    return true
                }
                i += c == 92 ? 2 : 1
            }
            this.bad = true
            this.p = this.n
            return false
        }

        skipValue(): boolean {
            const c = this.peek()
            if (c == 34) return this.skipString()
            if (c == 123 || c == 91) {
                let depth = 0
                while (this.p < this.n) {
                    const d = this.s.charCodeAt(this.p)
                    if (d == 34) {
                        if (!this.skipString()) return false
                        continue
                    }
                    if (d == 123 || d == 91) depth++
                    else if (d == 125 || d == 93) {
                        depth--
                        if (depth == 0) {
                            this.p++
                            return true
                        }
                    }
                    this.p++
                }
                this.bad = true
                return false
            }
            // number / true / false / null: up to the next delimiter; a scalar
            // that runs into the end of the text means the text was cut
            const start = this.p
            while (this.p < this.n) {
                const d = this.s.charCodeAt(this.p)
                if (d == 44 || d == 125 || d == 93 || d == 32 || d == 10 || d == 13 || d == 9) break
                this.p++
            }
            if (this.p == start || this.p >= this.n) {
                this.bad = true
                return false
            }
            return true
        }

        /** Number; true 1, false 0, null NaN. */
        number(): number {
            const c = this.peek()
            const start = this.p
            if (!this.skipValue()) return NaN
            if (c == 116) return 1
            if (c == 102) return 0
            if (c == 110) return NaN
            return parseFloat(this.s.substr(start, this.p - start))
        }

        /** A value as canonical JSON literal: numbers as sent, strings ASCII-only with \u escapes. */
        literal(): string {
            if (this.peek() == 34) return this.readString(true)
            const start = this.p
            if (!this.skipValue()) return ""
            return this.s.substr(start, this.p - start)
        }

        /** A value as text: strings decoded, numbers as written, null "". */
        text(): string {
            const c = this.peek()
            if (c == 34) return this.readString(false)
            const start = this.p
            if (!this.skipValue()) return ""
            return c == 110 ? "" : this.s.substr(start, this.p - start)
        }

        /**
         * At '"'. lit=false: decoded text (code points <= 0xFF as one byte,
         * above as UTF-8). lit=true: the canonical JSON literal, quotes
         * included. Plain runs are copied with one substr.
         */
        readString(lit: boolean): string {
            const s = this.s
            let i = this.p + 1
            let run = i
            let out = lit ? "\"" : ""
            while (i < this.n) {
                const c = s.charCodeAt(i)
                if (c == 34) {
                    this.p = i + 1
                    return out + s.substr(run, i - run) + (lit ? "\"" : "")
                }
                if (c != 92 && c < 128 && (c >= 32 || !lit)) {
                    i++
                    continue
                }
                out += s.substr(run, i - run)
                if (c == 92) {
                    if (i + 1 >= this.n) break
                    const e = s.charCodeAt(i + 1)
                    i += 2
                    if (e == 117) {
                        let cp = hexAt(s, i)
                        if (cp < 0) break
                        i += 4
                        if (cp >= 0xd800 && cp < 0xdc00 && s.charCodeAt(i) == 92 && s.charCodeAt(i + 1) == 117) {
                            const lo = hexAt(s, i + 2)
                            if (lo >= 0xdc00 && lo < 0xe000) {
                                cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00)
                                i += 6
                            }
                        }
                        out += lit ? escCp(cp) : cpText(cp)
                    } else if (lit) {
                        out += "\\" + String.fromCharCode(e)
                    } else {
                        out += e == 110 ? "\n" : e == 114 ? "\r" : e == 116 ? "\t" :
                            e == 98 ? String.fromCharCode(8) : e == 102 ? String.fromCharCode(12) : String.fromCharCode(e)
                    }
                } else if (c >= 128) {
                    const cp = decodeAt(s, i)
                    i += dLen
                    out += lit ? escCp(cp) : cpText(cp)
                } else {
                    out += escCp(c) // raw control char, literal mode
                    i++
                }
                run = i
            }
            this.bad = true
            this.p = this.n
            return out
        }
    }

    // ---- encoding -----------------------------------------------------------

    /** Length of the sequence decodeAt() just read. */
    let dLen = 1

    /**
     * Code point at s[i]: a valid UTF-8 sequence is decoded; any other byte
     * stands for itself (Latin-1, as pxt stores source literals). Sets dLen.
     */
    function decodeAt(s: string, i: number): number {
        const c = s.charCodeAt(i)
        dLen = 1
        if (c < 0xc2 || c > 0xf4) return c
        const need = c < 0xe0 ? 1 : c < 0xf0 ? 2 : 3
        if (i + need >= s.length) return c
        let cp = c & (need == 1 ? 0x1f : need == 2 ? 0x0f : 0x07)
        for (let k = 1; k <= need; k++) {
            const b = s.charCodeAt(i + k)
            if (b < 0x80 || b > 0xbf) return c
            cp = (cp << 6) | (b & 0x3f)
        }
        if ((need == 2 && cp < 0x800) || (need == 3 && (cp < 0x10000 || cp > 0x10ffff)) ||
            (cp >= 0xd800 && cp <= 0xdfff)) return c
        dLen = need + 1
        return cp
    }

    function hexDigit(c: number): number {
        if (c >= 48 && c <= 57) return c - 48
        c |= 32
        if (c >= 97 && c <= 102) return c - 87
        return -1
    }

    /** Four hex digits at s[i] -> value; -1 if not hex. */
    function hexAt(s: string, i: number): number {
        let v = 0
        for (let k = 0; k < 4; k++) {
            const h = hexDigit(s.charCodeAt(i + k))
            if (h < 0) return -1
            v = v * 16 + h
        }
        return v
    }

    /** Decimal digits from s[i] -> value; -1 if there is none. */
    function digits(s: string, i: number): number {
        let v = -1
        while (i < s.length) {
            const c = s.charCodeAt(i) - 48
            if (c < 0 || c > 9) break
            v = (v < 0 ? 0 : v * 10) + c
            i++
        }
        return v
    }

    function escCp(cp: number): string {
        if (cp >= 0x10000) {
            cp -= 0x10000
            return escCp(0xd800 + (cp >> 10)) + escCp(0xdc00 + (cp & 0x3ff))
        }
        const H = "0123456789abcdef"
        return "\\u" + H.charAt((cp >> 12) & 15) + H.charAt((cp >> 8) & 15) + H.charAt((cp >> 4) & 15) + H.charAt(cp & 15)
    }

    function utf8Of(cp: number): string {
        if (cp < 0x80) return String.fromCharCode(cp)
        if (cp < 0x800) return String.fromCharCode(0xc0 | (cp >> 6)) + String.fromCharCode(0x80 | (cp & 0x3f))
        if (cp < 0x10000) return String.fromCharCode(0xe0 | (cp >> 12)) +
            String.fromCharCode(0x80 | ((cp >> 6) & 0x3f)) + String.fromCharCode(0x80 | (cp & 0x3f))
        return String.fromCharCode(0xf0 | (cp >> 18)) + String.fromCharCode(0x80 | ((cp >> 12) & 0x3f)) +
            String.fromCharCode(0x80 | ((cp >> 6) & 0x3f)) + String.fromCharCode(0x80 | (cp & 0x3f))
    }

    /** Decoded text in the form source literals have: one byte up to 0xFF, UTF-8 above. */
    function cpText(cp: number): string {
        return cp < 256 ? String.fromCharCode(cp) : utf8Of(cp)
    }

    /**
     * JSON string literal, pure ASCII: `"` `\` and control chars escaped,
     * everything >= 0x80 as \uXXXX (UTF-8 sequences decoded, other bytes
     * Latin-1, see the file comment). Plain runs are copied with one substr.
     */
    export function jsonQuote(s: string): string {
        const n = s.length
        let out = "\""
        let run = 0
        let i = 0
        while (i < n) {
            const c = s.charCodeAt(i)
            if (c >= 32 && c < 127 && c != 34 && c != 92) {
                i++
                continue
            }
            out += s.substr(run, i - run)
            if (c == 34) out += "\\\""
            else if (c == 92) out += "\\\\"
            else if (c == 10) out += "\\n"
            else if (c == 13) out += "\\r"
            else if (c == 9) out += "\\t"
            else if (c < 128) out += escCp(c)
            else {
                out += escCp(decodeAt(s, i))
                i += dLen - 1
            }
            i++
            run = i
        }
        if (run == 0) return "\"" + s + "\""
        return out + s.substr(run, n - run) + "\""
    }

    /** Bytes for the module: valid UTF-8 kept, other bytes >= 0x80 (Latin-1 literals) converted. */
    export function toUtf8(s: string): string {
        const n = s.length
        let i = 0
        while (i < n && s.charCodeAt(i) < 128) i++
        if (i == n) return s
        let out = s.substr(0, i)
        while (i < n) {
            const cp = decodeAt(s, i)
            if (dLen > 1) out += s.substr(i, dLen)
            else out += utf8Of(cp)
            i += dLen
        }
        return out
    }

    /** Escape an AT string parameter: `"` `,` `\` get a backslash. */
    export function atEscape(s: string): string {
        let out = ""
        let run = 0
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i)
            if (c == 34 || c == 44 || c == 92) {
                out += s.substr(run, i - run) + "\\"
                run = i
            }
        }
        if (run == 0 && out.length == 0) return s
        return out + s.substr(run)
    }
}
