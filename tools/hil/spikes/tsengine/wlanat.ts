/**
 * AT engine for ESP-AT WiFi modules (ESP32-C3 with ESP-AT >= 2, ESP8266 /
 * ESP8285 with AT 1.x) on one exclusively owned UART (see wlanport.ts).
 *
 * Why this exists: the old drivers read replies with 100 ms pauses (RX
 * overflow), accepted "OK" as the CIPSEND prompt, never stripped +IPD framing,
 * threw URCs away and matched "ERROR" anywhere in the echo. This engine is
 * built around the opposite rules:
 *
 *  - One streaming parser sees every byte exactly once. It separates final
 *    result codes, the `>` prompt, info lines, URCs and LENGTH-FRAMED payloads.
 *    Payload bytes are counted, never scanned, so a body containing CRLF,
 *    "OK" or "ERROR" cannot end a transaction.
 *  - Exactly one command is in flight (a lock). Finals that arrive while no
 *    transaction waits (late replies to a timed-out command) are dropped as
 *    stale instead of being attributed to the next command.
 *  - URCs are never taken as a reply. They update the connection state and go
 *    to a bounded queue for the upper layer.
 *  - During a transaction the engine pumps the port every `pollMs` (~1 ms);
 *    the 254-byte RX buffer needs ~22 ms at 115200 baud to overflow.
 *
 * Time and sleeping are injected, so the Node tests drive the engine with a
 * fake clock and a scripted fake module (tools/unit).
 *
 * Strings are byte strings (calliopemini compiles with utf8=false), so
 * `.length` counts UART bytes, which is what the frame lengths count.
 *
 * Written in pxt Static TypeScript: no RegExp, Map, exceptions, getters,
 * optional chaining; NaN-safe comparisons (`!(a < b)`) wherever a number might
 * be missing. Flash matters more than elegance here: on the mini 2 the whole
 * TypeScript program has ~18 KB, so the code favours few, flat functions and
 * numeric codes over string juggling.
 */
namespace iotwlan {
    // ---- result codes of a transaction -------------------------------------
    export const AT_OK = "OK";
    export const AT_ERROR = "ERROR";
    export const AT_FAIL = "FAIL";
    export const AT_TIMEOUT = "TIMEOUT";
    /** module answered "busy" on every retry, or the engine lock was not free in time */
    export const AT_BUSY = "BUSY";

    // ---- module families (by AT firmware generation, from AT+GMR) -----------
    export const FAMILY_UNKNOWN = 0;
    /** AT 1.x (ESP8266 NonOS AT, e.g. Grove UART WiFi V2 with ESP8285) */
    export const FAMILY_ESP8266 = 1;
    /**
     * ESP-AT >= 2 (ESP32, ESP32-C3, ...). ESP8266 boards flashed with ESP-AT 2.x
     * land here too; `chip` tells them apart and gates TLS.
     */
    export const FAMILY_ESP32 = 2;

    // ---- parser internals ---------------------------------------------------

    // Frame kinds. A frame is either kept whole or dropped whole (decided from
    // its announced length), so a bound never leaves a hole inside the data.
    const FRAME_IPD = 1;      // active socket data -> receive buffer
    const FRAME_REPLY = 2;    // +CIPRECVDATA / +HTTPC* -> transaction payload
    const FRAME_DROP = 3;     // over a bound or nobody waiting

    const SCAN_NO = 0;
    const SCAN_YES = 1;
    const SCAN_MORE = 2;

    /** A line longer than this without LF is noise (wrong baud, garbage) and is cut. */
    const MAX_LINE = 256;
    /** Frame headers are short; anything longer is not a header. */
    const MAX_HEADER = 24;
    /** Sanity bound for a frame length; ESP-AT never sends more per frame. */
    const MAX_FRAME_LEN = 8192;
    const MAX_LINES = 24;
    const MAX_URCS = 16;
    /** Writes longer than this are split, pumping between the pieces. */
    const WRITE_CHUNK = 64;

    const PHASE_COMMAND = 0;
    const PHASE_PROMPT = 1;
    const PHASE_DATA = 2;

    // Final result lines (exact whole-line matches) and what they map to.
    // Index + 1 is the internal final code; codes >= FIN_SEND_OK end sends only.
    const FINALS = ["OK", "ERROR", "FAIL", "SEND OK", "SEND FAIL"];
    const FINAL_RESULT = ["", AT_OK, AT_ERROR, AT_FAIL, AT_OK, AT_FAIL];
    const FIN_OK = 1;
    const FIN_SEND_OK = 4;

    // Frame prefixes, matched only at the start of a line. +CIPRECVDATA omits
    // its separator: AT 3.x prints "+CIPRECVDATA:<len>," while some AT 1.x
    // builds print "+CIPRECVDATA,<len>:".
    const FRAME_PREFIXES = ["+IPD,", "+CIPRECVDATA", "+HTTPCPOST:", "+HTTPCLIENT:", "+HTTPCGET:"];

    // URC kinds
    const U_NONE = 0;
    const U_OTHER = 1;
    const U_WIFI = 2;
    const U_GOT_IP = 3;
    const U_WIFI_LOST = 4;
    const U_LINK_UP = 5;
    const U_LINK_DOWN = 6;
    const U_READY = 7;
    const U_BUSY = 8;
    const U_IPD = 9;

    /** Outcome of one AT transaction. */
    export class AtResult {
        /** AT_OK | AT_ERROR | AT_FAIL | AT_TIMEOUT | AT_BUSY */
        code: string;
        /** info lines of the reply (no echo, no URCs, no finals) */
        lines: string[];
        /** concatenated length-framed payloads that arrived during the transaction */
        payload: string;
        /** two-phase send only: the prompt was seen and the data was written */
        sent: boolean;
        /** the module rebooted ("ready") while the transaction was in flight */
        reset: boolean;
        /** a line or payload bound was hit and something was dropped */
        truncated: boolean;

        constructor() {
            this.code = AT_TIMEOUT;
            this.lines = [];
            this.payload = "";
            this.sent = false;
            this.reset = false;
            this.truncated = false;
        }

        isOk(): boolean {
            return this.code == AT_OK;
        }

        /** First info line starting with `prefix`, "" if none. */
        line(prefix: string): string {
            for (let i = 0; i < this.lines.length; i++) {
                if (startsWith(this.lines[i], prefix)) return this.lines[i];
            }
            return "";
        }
    }

    /**
     * What the module can do, decided once from AT+GMR. Defaults are the
     * conservative ones from plan §2.5: only what was measured (ESP32-C3,
     * AT 3.3) is switched on; AT 1.x and unknown firmware get the plain-TCP,
     * active-+IPD fallback until a probe proves more.
     */
    export class Capabilities {
        family: number;
        /** "3.3.0.0", "" if not reported */
        version: string;
        /** -1 if unknown */
        major: number;
        /** -1 if unknown */
        minor: number;
        /** "ESP32C3", "ESP8266", ... ; "" if the firmware does not say (AT 1.x) */
        chip: string;
        /** text after "Bin version...:", e.g. "v3.3.0.0(MINI-1)" */
        bin: string;
        /** AT+HTTPCLIENT / AT+HTTPCPOST available */
        httpClient: boolean;
        /** AT+CIPRECVMODE=1 / AT+CIPRECVDATA available */
        passiveRecv: boolean;
        /** HTTPS / SSL connections are usable */
        tls: boolean;
        /** AT+SYSSTORE and AT+CWSTATE available (else use the _CUR commands) */
        sysstore: boolean;

        constructor() {
            this.family = FAMILY_UNKNOWN;
            this.version = "";
            this.major = -1;
            this.minor = -1;
            this.chip = "";
            this.bin = "";
            this.httpClient = false;
            this.passiveRecv = false;
            this.tls = false;
            this.sysstore = false;
        }
    }

    /**
     * Parse the info lines of AT+GMR.
     *   ESP-AT 3.x: "AT version:3.3.0.0(3b13d04 - ESP32C3 - May  8 2024 08:21:54)"
     *   AT 1.x:     "AT version:1.7.4.0(May 11 2020 19:13:04)"
     */
    export function parseGmr(lines: string[]): Capabilities {
        const caps = new Capabilities();
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (startsWith(l, "AT version:")) {
                let end = l.indexOf("(");
                if (end < 0) end = l.length;
                // (no trim(): it drags ~0.5 KB of helpers into the mini 2 image)
                const v = l.substr(11, end - 11);
                caps.version = v;
                let d1 = v.indexOf(".");
                if (d1 < 0) d1 = v.length;
                caps.major = parseUint(v, 0, d1);
                let d2 = v.indexOf(".", d1 + 1);
                if (d2 < 0) d2 = v.length;
                caps.minor = parseUint(v, d1 + 1, d2);
                // ESP-AT >= 2 names the chip: "(<commit> - ESP32C3 - <date>)"
                const e = l.indexOf(" - ESP", end);
                if (e > 0) {
                    let t = e + 3;
                    while (t < l.length && l.charCodeAt(t) != 32 && l.charCodeAt(t) != 41) t++;
                    caps.chip = l.substr(e + 3, t - e - 3);
                }
            } else if (startsWith(l, "Bin version")) {
                caps.bin = l.substr(l.indexOf(":") + 1);
            }
        }
        if (caps.major >= 2) {
            caps.family = FAMILY_ESP32;
            // HTTPCPOST and SYSSTORE/CWSTATE arrived with ESP-AT 2.1; 2.0 gets
            // the TCP fallback. CIPRECVMODE exists in every ESP-AT 2.x.
            const atLeast21 = caps.major > 2 || caps.minor >= 1;
            caps.httpClient = atLeast21;
            caps.sysstore = atLeast21;
            caps.passiveRecv = true;
            // TLS on an ESP8266 running ESP-AT 2.x runs out of heap in practice.
            caps.tls = caps.chip.indexOf("ESP8266") < 0;
        } else if (caps.major == 1) {
            // Passive receive exists only in late 1.x builds; not measured yet,
            // so stay on active +IPD until a probe (AT+CIPRECVMODE=1 -> OK) says so.
            caps.family = FAMILY_ESP8266;
        }
        return caps;
    }

    /** Decimal digits of s[from, to) -> value; -1 if empty or not all digits. */
    export function parseUint(s: string, from: number, to: number): number {
        if (!(from < to)) return -1;
        let v = 0;
        for (let i = from; i < to; i++) {
            const c = s.charCodeAt(i) - 48;
            if (c < 0 || c > 9) return -1;
            v = v * 10 + c;
        }
        return v;
    }

    export function startsWith(s: string, prefix: string): boolean {
        return matchAt(s, 0, prefix) == SCAN_YES;
    }

    /** Is `p` at s[pos]? SCAN_YES / SCAN_NO / SCAN_MORE (s ends first). No allocation. */
    function matchAt(s: string, pos: number, p: string): number {
        for (let i = 0; i < p.length; i++) {
            if (pos + i >= s.length) return SCAN_MORE;
            if (s.charCodeAt(pos + i) != p.charCodeAt(i)) return SCAN_NO;
        }
        return SCAN_YES;
    }

    /** 1-based index into FINALS, 0 if the line is no final result code. */
    function finalCode(line: string): number {
        // Whole-line matches only: "ERROR" inside an echo or info line is not a result.
        for (let i = 0; i < FINALS.length; i++) {
            if (line == FINALS[i]) return i + 1;
        }
        return 0;
    }

    function urcKind(line: string): number {
        const c = line.charCodeAt(0);
        if (c == 87) { // 'W'
            if (!startsWith(line, "WIFI ")) return U_NONE;
            if (line == "WIFI CONNECTED") return U_WIFI;
            if (line == "WIFI GOT IP") return U_GOT_IP;
            if (startsWith(line, "WIFI DISCONNECT")) return U_WIFI_LOST;
            return U_OTHER; // WIFI GOT IPv6 ...
        }
        if (c == 98) return startsWith(line, "busy") ? U_BUSY : U_NONE; // 'b'
        if (c == 43) { // '+'
            // A colon-less "+IPD,<len>" is the passive notification; active
            // +IPD is framed and never reaches here.
            if (startsWith(line, "+IPD,")) return U_IPD;
            if (startsWith(line, "+STA_") || startsWith(line, "+DIST_STA_IP") || startsWith(line, "+TIME_UPDATED")) return U_OTHER;
            return U_NONE;
        }
        if (line == "ready") return U_READY;
        // "CONNECT"/"CLOSED", or "<id>,CONNECT" in multi-connection mode
        const s = line.charCodeAt(1) == 44 ? line.substr(2) : line;
        if (s == "CONNECT") return U_LINK_UP;
        if (s == "CLOSED" || s == "CONNECT FAIL") return U_LINK_DOWN;
        return U_NONE;
    }

    /**
     * The engine. One instance per module. Not tied to pxt APIs: the port,
     * the clock and the sleep function are injected (see `startEngine` for
     * the device wiring).
     */
    export class AtEngine {
        // -- stream buffer: the unconsumed bytes are buf.substr(pos) --
        // (hot fields first: small field offsets give shorter code)
        private buf: string;
        private pos: number;
        private frameLeft: number;
        private frameKind: number;
        /** the prompt is "> " on AT 1.x; drop that one space */
        private skipSpace: boolean;

        // -- transaction (meaningful while txActive) --
        private txActive: boolean;
        private txPhase: number;
        private txFinal: number;
        private txPrompt: boolean;
        private txBusy: boolean;
        private txBusyAt: number;
        private txReset: boolean;
        private txTrunc: boolean;
        private txEcho: string;
        private txLines: string[];
        private txPayload: string;
        /** bytes announced by the reply frames of this transaction (kept or not) */
        private txPayloadLen: number;
        private locked: boolean;

        // -- unsolicited data --
        private urcs: string[];
        /**
         * Active socket data. Plain string appends: pxt's Array.join is itself
         * a += loop, so collecting pieces would only add an array and code.
         * The copying stays bounded by maxRecv / maxPayload.
         */
        private recvData: string;

        // -- injected environment --
        private port: Port;
        private nowFn: () => number;
        private sleepFn: (ms: number) => void;

        // -- tunables (plain fields: pxt has no setters) --
        /** sleep between pumps while waiting inside a transaction */
        pollMs: number;
        /** sleep between pumps of the background fiber while idle */
        idleMs: number;
        /** how often a command is re-sent after "busy p..." */
        busyRetries: number;
        /** wait after "busy" before re-sending */
        busyDelayMs: number;
        /** bound for payload bytes per transaction */
        maxPayload: number;
        /** bound for buffered active +IPD bytes */
        maxRecv: number;

        // -- connection state, driven by URCs only --
        wifiConnected: boolean;
        wifiGotIp: boolean;
        /** TCP/SSL link: CONNECT seen, CLOSED not yet */
        linkOpen: boolean;
        /** bytes announced by passive "+IPD,<len>" and not yet fetched */
        passivePending: number;
        /** module echoes commands (true after power-up / "ready" until ATE0) */
        echoOn: boolean;
        /** capabilities from the last detect() */
        caps: Capabilities;

        // -- counters for diagnosis --
        /** "ready" seen: the module rebooted */
        resets: number;
        /** "busy p/s..." seen */
        busyCount: number;
        /** result codes nobody was waiting for (late replies) */
        staleFinals: number;
        /** URCs pushed out of the full queue + payload bytes dropped (bound hit or nobody waiting) */
        lost: number;

        constructor(port: Port, now: () => number, sleep: (ms: number) => void) {
            this.buf = "";
            this.pos = 0;
            this.frameLeft = 0;
            this.frameKind = 0;
            this.skipSpace = false;

            this.txActive = false;
            this.txPhase = PHASE_COMMAND;
            this.txFinal = 0;
            this.txPrompt = false;
            this.txBusy = false;
            this.txBusyAt = 0;
            this.txReset = false;
            this.txTrunc = false;
            this.txEcho = "";
            this.txLines = [];
            this.txPayload = "";
            this.txPayloadLen = 0;
            this.locked = false;

            this.urcs = [];
            this.recvData = "";

            this.port = port;
            this.nowFn = now;
            this.sleepFn = sleep;

            this.pollMs = 1;
            this.idleMs = 10;
            this.busyRetries = 8;
            this.busyDelayMs = 250;
            this.maxPayload = 1536;
            this.maxRecv = 2048;

            this.wifiConnected = false;
            this.wifiGotIp = false;
            this.linkOpen = false;
            this.passivePending = 0;
            this.echoOn = true;
            this.caps = new Capabilities();

            this.resets = 0;
            this.busyCount = 0;
            this.staleFinals = 0;
            this.lost = 0;
        }

        // =====================================================================
        // Transactions
        // =====================================================================

        /**
         * Send one AT command (without CRLF) and wait for OK / ERROR / FAIL.
         * `timeoutMs` restarts after each "busy" re-send.
         */
        command(cmd: string, timeoutMs: number): AtResult {
            return this.transact(cmd, "", false, timeoutMs);
        }

        /**
         * Two-phase send for AT+CIPSEND / AT+HTTPCPOST: send `cmd`, wait for
         * the `>` prompt ONLY (the "OK" printed before it is not the prompt),
         * then write `data` and wait for SEND OK / SEND FAIL / ERROR, collecting
         * any length-framed payload (e.g. "+HTTPCPOST:<len>,<body>") meanwhile.
         * SEND OK maps to AT_OK, SEND FAIL to AT_FAIL. `sent` tells whether the
         * data went out; if it did not, the module never entered data mode.
         */
        sendWithPrompt(cmd: string, data: string, timeoutMs: number): AtResult {
            return this.transact(cmd, data, true, timeoutMs);
        }

        /** True while a transaction holds the lock. */
        isBusy(): boolean {
            return this.locked;
        }

        /**
         * Wake-up / resync: "AT" until OK. Also recovers a module left in data
         * mode by a timed-out send: the "AT\r\n" bytes fill its pending count.
         */
        sync(attempts: number, perTryMs: number): boolean {
            for (let i = 0; i < attempts; i++) {
                if (this.command("AT", perTryMs).code == AT_OK) return true;
            }
            return false;
        }

        /** ATE0. The parser tolerates echo anyway; this just saves UART time. */
        disableEcho(timeoutMs: number): boolean {
            const ok = this.command("ATE0", timeoutMs).code == AT_OK;
            if (ok) this.echoOn = false;
            return ok;
        }

        /** AT+GMR -> capabilities (conservative defaults if the query fails). */
        detect(timeoutMs: number): Capabilities {
            const r = this.command("AT+GMR", timeoutMs);
            this.caps = parseGmr(r.code == AT_OK ? r.lines : []);
            return this.caps;
        }

        private transact(cmd: string, data: string, withPrompt: boolean, timeoutMs: number): AtResult {
            const res = new AtResult();
            // pxt fibers are cooperative: test-and-set without a yield in
            // between is atomic. A second caller waits (the owner pumps) and
            // gives up with AT_BUSY after its own timeout.
            let start = this.nowFn();
            while (this.locked) {
                if (!(this.nowFn() - start < timeoutMs)) {
                    res.code = AT_BUSY;
                    return res;
                }
                this.sleepFn(this.idleMs);
            }
            this.locked = true;

            // Whatever is buffered now predates this command (late replies to a
            // timed-out transaction, URCs). Parsing it with no transaction
            // active drops stale finals instead of attributing them to us.
            // Read until the port is empty, not just once: a reply may come
            // out of the port in several pieces. (Bytes still on the wire
            // cannot be told apart; the module's "busy" covers most of that.)
            for (let i = 0; i < 32; i++) {
                if (!this.pump()) break;
            }

            this.txActive = true;
            this.txEcho = cmd;
            this.txPhase = withPrompt ? PHASE_PROMPT : PHASE_COMMAND;
            this.txFinal = 0;
            this.txPrompt = false;
            this.txBusy = false;
            this.txReset = false;
            this.txTrunc = false;
            this.txLines = [];
            this.txPayload = "";
            this.txPayloadLen = 0;

            const line = cmd + "\r\n";
            this.writeAll(line);
            let attempts = 0;
            start = this.nowFn();
            while (true) {
                this.pump();
                if (this.txReset) {
                    res.reset = true;
                    res.code = AT_ERROR;
                    break;
                }
                if (this.txBusy) {
                    // (Never set after the prompt, see onUrc: in data mode a
                    // re-sent command would be swallowed as payload.)
                    if (!(this.nowFn() - this.txBusyAt < this.busyDelayMs)) {
                        if (attempts >= this.busyRetries) {
                            res.code = AT_BUSY;
                            break;
                        }
                        attempts++;
                        // "busy p..." means the module discarded our command.
                        // Lines seen so far belong to whatever kept it busy.
                        this.txBusy = false;
                        this.txLines = [];
                        this.writeAll(line);
                        start = this.nowFn();
                    }
                } else if (this.txFinal > 0) {
                    res.code = FINAL_RESULT[this.txFinal];
                    break;
                } else if (this.txPrompt && this.txPhase == PHASE_PROMPT) {
                    // Switch phase BEFORE writing: finals that show up while the
                    // data drains belong to the data phase.
                    this.txPhase = PHASE_DATA;
                    this.writeAll(data);
                    res.sent = true;
                    start = this.nowFn();
                    continue;
                }
                if (!(this.nowFn() - start < timeoutMs)) {
                    res.code = AT_TIMEOUT;
                    break;
                }
                this.sleepFn(this.pollMs);
            }
            res.lines = this.txLines;
            res.payload = this.txPayload;
            res.truncated = this.txTrunc;
            this.txActive = false;
            this.txLines = [];
            this.txPayload = "";
            this.locked = false;
            return res;
        }

        /** Long writes go out in pieces with a pump in between, so a module
         *  that talks while we transmit cannot overflow the RX buffer. */
        private writeAll(s: string): void {
            for (let i = 0; i < s.length; i += WRITE_CHUNK) {
                if (i > 0) this.pump();
                this.port.write(s.length <= WRITE_CHUNK ? s : s.substr(i, WRITE_CHUNK));
            }
        }

        // =====================================================================
        // Pumping and unsolicited data
        // =====================================================================

        /** Read whatever the port has and parse it. True if bytes arrived. */
        pump(): boolean {
            const chunk = this.port.read();
            if (chunk.length == 0) return false;
            this.feed(chunk);
            return true;
        }

        /** Background tick: pump unless a transaction is pumping already. */
        idle(): void {
            if (!this.locked) this.pump();
        }

        /** Pump for `ms` milliseconds (e.g. to collect URCs after a command). */
        pumpFor(ms: number): void {
            this.waitRecv(-1, ms);
        }

        /**
         * Pump until at least `minBytes` of active socket data (+IPD) are
         * buffered. Returns early when the link is known closed: CLOSED comes
         * after the last +IPD in the stream, so everything is parsed by then.
         * minBytes < 0 just pumps for timeoutMs.
         */
        waitRecv(minBytes: number, timeoutMs: number): boolean {
            const start = this.nowFn();
            while (true) {
                this.pump();
                if (minBytes >= 0) {
                    if (this.recvData.length >= minBytes) return true;
                    if (!this.linkOpen) return false;
                }
                if (!(this.nowFn() - start < timeoutMs)) return false;
                this.sleepFn(this.pollMs);
            }
        }

        /** Bytes of active socket data buffered. */
        recvAvailable(): number {
            return this.recvData.length;
        }

        /** Take up to `max` bytes of buffered socket data (all if max < 0). */
        recvTake(max: number): string {
            const all = this.recvData;
            if (max >= 0 && max < all.length) {
                this.recvData = all.substr(max);
                return all.substr(0, max);
            }
            this.recvData = "";
            return all;
        }

        /** Oldest queued URC, "" if none. */
        takeUrc(): string {
            if (this.urcs.length == 0) return "";
            return this.urcs.shift();
        }

        urcCount(): number {
            return this.urcs.length;
        }

        // =====================================================================
        // Streaming parser
        // =====================================================================

        /** Feed received bytes; chunks may split anything anywhere. */
        feed(chunk: string): void {
            // Keep only the unconsumed tail. Payload bytes are handed out as
            // they arrive, so the tail is at most one partial line or header
            // and this copy stays small even while a kilobyte frame streams in.
            this.buf = this.pos < this.buf.length ? this.buf.substr(this.pos) + chunk : chunk;
            this.pos = 0;
            const buf = this.buf;
            const n = buf.length;
            while (this.pos < n) {
                if (this.frameLeft > 0) {
                    // Inside a frame: pass bytes through uninterpreted.
                    let take = n - this.pos;
                    if (take > this.frameLeft) take = this.frameLeft;
                    const k = this.frameKind;
                    if (k == FRAME_IPD) this.recvData += buf.substr(this.pos, take);
                    else if (k == FRAME_REPLY) this.txPayload += buf.substr(this.pos, take);
                    this.pos += take;
                    this.frameLeft -= take;
                    continue;
                }
                // Line mode: pos is always at the start of a line here.
                const c = buf.charCodeAt(this.pos);
                if (this.skipSpace) {
                    this.skipSpace = false;
                    if (c == 32) {
                        this.pos++;
                        continue;
                    }
                }
                if (c == 62) {
                    // '>' at line start is the send prompt. It is never
                    // followed by CRLF, so it cannot wait for a line end.
                    this.pos++;
                    this.skipSpace = true;
                    if (this.txActive && this.txPhase == PHASE_PROMPT) {
                        if (!this.txBusy) this.txPrompt = true;
                    }
                    continue;
                }
                if (c == 43) {
                    // '+' may open a length-framed payload; decide before
                    // looking for LF, because the payload may contain LFs.
                    const r = this.scanFrame();
                    if (r == SCAN_MORE) return;
                    if (r == SCAN_YES) continue;
                }
                const eol = buf.indexOf("\n", this.pos);
                if (eol < 0) {
                    if (n - this.pos <= MAX_LINE) return;
                    this.onLine(buf.substr(this.pos, MAX_LINE));
                    this.pos += MAX_LINE;
                    continue;
                }
                let end = eol;
                while (end > this.pos && buf.charCodeAt(end - 1) == 13) end--;
                const line = buf.substr(this.pos, end - this.pos);
                this.pos = eol + 1;
                this.onLine(line);
            }
        }

        /**
         * At a '+': is this a frame header? Consumes the header and enters
         * frame mode if so.
         *   +IPD,<len>:  +IPD,<id>,<len>:              active data
         *   +IPD,<len>   (no colon)                     passive notification: a line
         *   +CIPRECVDATA:<len>,   +CIPRECVDATA,<len>:
         *   +HTTPCPOST:<len>,  +HTTPCLIENT:<len>,  +HTTPCGET:<len>,
         * AT+CIPDINFO=1 headers (remote IP/port) are not supported; the driver
         * keeps CIPDINFO off.
         */
        private scanFrame(): number {
            const buf = this.buf;
            let k = 0;
            let i = -1;
            let more = false;
            for (; k < FRAME_PREFIXES.length; k++) {
                const m = matchAt(buf, this.pos, FRAME_PREFIXES[k]);
                if (m == SCAN_YES) {
                    i = this.pos + FRAME_PREFIXES[k].length;
                    break;
                }
                if (m == SCAN_MORE) more = true;
            }
            if (i < 0) return more ? SCAN_MORE : SCAN_NO;

            // Numbers separated by ','. ':' ends every header; ',' after a
            // number ends the non-IPD ones (for +IPD it separates <id>,<len>).
            // A separator before any digit is +CIPRECVDATA's own ':' or ','.
            const hs = i;
            let num = -1;
            while (true) {
                if (i - hs > MAX_HEADER) return SCAN_NO;
                if (i >= buf.length) return SCAN_MORE;
                const c = buf.charCodeAt(i) - 48;
                if (c >= 0 && c <= 9) {
                    num = (num < 0 ? 0 : num * 10) + c;
                } else if (c == 10 || c == -4) { // ':' or ','
                    if (num < 0) {
                        if (i > hs) return SCAN_NO;
                    } else if (c == 10 || k > 0) {
                        break;
                    } else {
                        num = -1;
                    }
                } else {
                    // CR/LF after "+IPD,<len>": the passive notification.
                    return SCAN_NO;
                }
                i++;
            }
            if (num > MAX_FRAME_LEN) return SCAN_NO;

            this.pos = i + 1;
            this.frameLeft = num;
            let kind = FRAME_REPLY;
            if (k == 0) {
                kind = this.recvData.length + num > this.maxRecv ? FRAME_DROP : FRAME_IPD;
            } else {
                if (k == 1) {
                    this.passivePending -= num;
                    if (this.passivePending < 0) this.passivePending = 0;
                }
                if (!this.txActive || this.txBusy) {
                    // nobody waits, or it answers what made the module busy
                    kind = FRAME_DROP;
                } else if (this.txPayloadLen + num > this.maxPayload) {
                    kind = FRAME_DROP;
                    this.txTrunc = true;
                } else {
                    this.txPayloadLen += num;
                }
            }
            if (kind == FRAME_DROP) this.lost += num;
            this.frameKind = kind;
            return SCAN_YES;
        }

        private onLine(line: string): void {
            if (line.length == 0) return;
            // Echo (before ATE0 or after a module reset). Exact match only:
            // an SSID like "ERRORNET" must not look like a result code, and a
            // reply never equals the command text.
            if (this.txActive && line == this.txEcho) return;
            const fin = finalCode(line);
            if (fin > 0) {
                this.onFinal(fin);
                return;
            }
            const u = urcKind(line);
            if (u != U_NONE) {
                this.onUrc(line, u);
                return;
            }
            // Info line. Nobody asked, or it belongs to what made the module
            // busy: dropped, it carries no state.
            if (!this.txActive || this.txBusy) return;
            if (this.txLines.length < MAX_LINES) this.txLines.push(line);
            else this.txTrunc = true;
        }

        private onFinal(code: number): void {
            // Not ours: nobody waits, a final is already in, or it answers the
            // command that made the module busy (ours was discarded).
            if (!this.txActive || this.txBusy || this.txFinal > 0) {
                this.staleFinals++;
                return;
            }
            if (code == FIN_OK) {
                // CIPSEND/HTTPCPOST print OK before '>', and a send ends only
                // with SEND OK / SEND FAIL / ERROR.
                if (this.txPhase != PHASE_COMMAND) return;
            } else if (code >= FIN_SEND_OK && this.txPhase != PHASE_DATA) {
                this.staleFinals++; // leftover of an earlier send
                return;
            }
            this.txFinal = code;
        }

        private onUrc(line: string, u: number): void {
            if (u == U_WIFI) {
                this.wifiConnected = true;
            } else if (u == U_GOT_IP) {
                this.wifiConnected = true;
                this.wifiGotIp = true;
            } else if (u == U_WIFI_LOST) {
                this.wifiConnected = false;
                this.wifiGotIp = false;
                this.linkOpen = false;
            } else if (u == U_LINK_UP) {
                this.linkOpen = true;
            } else if (u == U_LINK_DOWN) {
                this.linkOpen = false;
            } else if (u == U_READY) {
                // The module rebooted (brown-out, watchdog, AT+RST): all its
                // state is gone and echo is back on.
                this.resets++;
                this.wifiConnected = false;
                this.wifiGotIp = false;
                this.linkOpen = false;
                this.passivePending = 0;
                this.echoOn = true;
                if (this.txActive) this.txReset = true;
            } else if (u == U_BUSY) {
                this.busyCount++;
                // Once the prompt is seen the module is in data mode; a busy
                // then cannot mean "command discarded", and re-sending the
                // command would be swallowed as payload.
                if (this.txActive && this.txFinal == 0 && !this.txBusy && !this.txPrompt) {
                    this.txBusy = true;
                    this.txBusyAt = this.nowFn();
                }
            } else if (u == U_IPD) {
                // "+IPD,<len>" or "+IPD,<id>,<len>": the length is the last field.
                const comma = line.indexOf(",", 5);
                const len = parseUint(line, comma < 0 ? 5 : comma + 1, line.length);
                if (len > 0) this.passivePending += len;
            }
            if (this.urcs.length >= MAX_URCS) {
                this.urcs.shift();
                this.lost++;
            }
            this.urcs.push(line);
        }
    }

    /**
     * Device wiring: engine on the pxt clock plus a background fiber that
     * pumps while no transaction is running, so URCs and unsolicited +IPD
     * data are drained even when nobody waits for them. Only for the device;
     * the Node tests construct AtEngine with a fake clock instead.
     */
    export function startEngine(port: Port): AtEngine {
        const engine = new AtEngine(port, () => control.millis(), (ms: number) => basic.pause(ms));
        control.inBackground(() => {
            while (true) {
                engine.idle();
                basic.pause(engine.idleMs);
            }
        });
        return engine;
    }
}
