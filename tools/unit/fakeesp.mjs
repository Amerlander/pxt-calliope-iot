// Scripted fake ESP-AT module + fake clock for the AT engine tests.
//
// The fake implements the engine's Port (write/read). It reacts to written
// command lines with outputs captured from a real ESP32-C3 (ESP-AT 3.3.0.0) on
// 2026-09-29, and models the parts of the module the engine must cope with:
//   - echo until ATE0 (echoed as "<cmd>\r\r\n", like the module),
//   - "busy p..." while a previous command is still being processed,
//   - data mode after the `>` prompt (the next N written bytes are payload),
//   - optional random splitting of the output stream (property tests),
//   - optional UART timing: bytes arrive at baud/10 per second into a 254-byte
//     RX buffer and overflow exactly like the runtime's buffer would.

/** Fake time. sleep() advances it and fires hooks (simulated other fibers). */
export class Clock {
    constructor() {
        this.t = 0;
        this.hooks = [];
        this.now = () => this.t;
        this.sleep = (ms) => {
            this.t += ms > 0 ? ms : 0;
            for (const h of this.hooks) {
                if (!h.done && this.t >= h.at) { h.done = true; h.fn(); }
            }
        };
    }
    /** Run fn once, from inside the first sleep() that reaches time `at`. */
    at(at, fn) { this.hooks.push({ at, fn, done: false }); }
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---- captured module output ------------------------------------------------

export const GMR_ESP32C3 = [
    "AT version:3.3.0.0(3b13d04 - ESP32C3 - May  8 2024 08:21:54)",
    "SDK version:v5.0.6-dirty",
    "compile time(be332568):May  8 2024 08:51:33",
    "Bin version:v3.3.0.0(MINI-1)",
    "",
    "OK",
];

export const GMR_ESP8266_AT1 = [
    "AT version:1.7.4.0(May 11 2020 19:13:04)",
    "SDK version:3.0.4(9532ceb)",
    "compile time:May 27 2020 10:12:17",
    "Bin version(Wroom 02):1.7.4",
    "OK",
];

/** Body of the production health check. The module reported 51 bytes: 50 of JSON plus the server's "\n". */
export const HEALTH_BODY = '{"message":"API is healthy.","code":200,"data":{}}\n';

/** Text that would break a line-based reader if it leaked out of a frame. */
export const POISON = "\r\nOK\r\nERROR\r\nFAIL\r\n>\r\n+IPD,3:abc\r\nSEND OK\r\nready\r\nbusy p...\r\nWIFI DISCONNECT\r\nCLOSED\r\n+CIPRECVDATA:4,xxxx\r\n";

/** An HTTP response of exactly `total` bytes with POISON inside the body. */
export function httpResponse(total, extraHeader = "") {
    const head = (len) =>
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" + extraHeader +
        `Content-Length: ${len}\r\nConnection: close\r\n\r\n`;
    let bodyLen = total - head(0).length;
    // Content-Length digits change the header size; settle it.
    for (let i = 0; i < 3; i++) bodyLen = total - head(bodyLen).length;
    const start = '{"poison":"';
    const end = '"}';
    let body = start + POISON;
    let k = 0;
    while (body.length < bodyLen - end.length) body += String.fromCharCode(97 + (k++ % 26));
    body = body.slice(0, bodyLen - end.length) + end;
    const r = head(bodyLen) + body;
    if (r.length !== total) throw new Error(`httpResponse: ${r.length} != ${total}`);
    return r;
}

/** A request of exactly `total` bytes. */
export function httpRequest(total) {
    let r = "POST /api/iot/v1/ingest HTTP/1.1\r\nHost: 192.168.1.172:8090\r\nContent-Type: application/json\r\n";
    const tail = "\r\n";
    const cl = (n) => `Content-Length: ${n}\r\n`;
    let bodyLen = total - r.length - cl(0).length - tail.length;
    for (let i = 0; i < 3; i++) bodyLen = total - r.length - cl(bodyLen).length - tail.length;
    let body = '{"d":1,"p":[';
    while (body.length < bodyLen - 2) body += "1";
    body = body.slice(0, bodyLen - 2) + "]}";
    r = r + cl(bodyLen) + tail + body;
    if (r.length !== total) throw new Error(`httpRequest: ${r.length} != ${total}`);
    return r;
}

// ---- the fake module ---------------------------------------------------------

export class FakeEsp {
    /**
     * opts.split: () => number in [0,1) — deliver random prefixes of the output
     * opts.baud: model UART timing and the RX buffer (0 = instant, unbounded)
     * opts.rxCap: RX buffer size for the baud model (default 254)
     * opts.echo: initial echo state (default true, like after power-up)
     * opts.promptGap: ms between "OK\r\n\r\n" and ">" of a send (default 5)
     * opts.recvMode: 0 active (+IPD with data) / 1 passive (+IPD,<len> notification)
     */
    constructor(clock, opts = {}) {
        this.clock = clock;
        this.split = opts.split || null;
        this.baud = opts.baud || 0;
        this.rxCap = opts.rxCap ?? 254;
        this.echo = opts.echo ?? true;
        this.promptGap = opts.promptGap ?? 5;
        this.recvMode = opts.recvMode ?? 0;

        this.sched = [];        // pending output: { at, text, prompt }
        this.avail = "";        // arrived in the RX buffer, not read yet
        this.wireFree = 0;      // baud model: when the line is free again
        this.delivered = 0;     // bytes that made it into the RX buffer
        this.readTotal = 0;     // bytes the engine has read
        this.promptOffset = -1; // stream offset of the last '>' delivered
        this.promptSeen = true; // the engine has read the last prompt
        this.overflow = 0;      // bytes lost to a full RX buffer

        this.inbuf = "";
        this.written = "";      // everything the engine wrote
        this.log = [];          // command lines received
        this.busyUntil = 0;
        this.busyRejected = 0;
        this.dataLeft = 0;
        this.dataBuf = "";
        this.onData = null;
        this.received = [];     // payloads received in data mode
        this.violations = [];

        this.passiveBuf = "";   // passive mode: server bytes held by the module
        this.response = httpResponse(1223); // what the "server" answers to a CIPSEND
        this.handlers = [];
        installDefaults(this);
    }

    // -- scripting API --

    /** Handle commands matching `m` (exact string, RegExp or predicate). Later handlers win. */
    on(m, fn) { this.handlers.push([m, fn]); return this; }

    /** Schedule output `delay` ms from now. */
    emit(text, delay = 1, prompt = false) {
        const at = this.clock.t + delay;
        let i = this.sched.length;
        while (i > 0 && this.sched[i - 1].at > at) i--;
        this.sched.splice(i, 0, { at, text, prompt });
        return at;
    }

    /**
     * Reply to the current command: steps are [delayMs, text] pairs (or plain
     * text = 1 ms). The module counts as busy until the last step.
     */
    reply(steps) {
        let last = this.clock.t;
        for (const s of steps) {
            const [d, text] = typeof s === "string" ? [1, s] : s;
            last = Math.max(last, this.emit(text, d));
        }
        this.busyUntil = Math.max(this.busyUntil, last);
    }

    /** Print "OK", then the prompt, then take `n` bytes of data and call fn(data). */
    prompt(n, fn) {
        this.emit("OK\r\n\r\n", 1);
        const at = this.emit(">", 1 + this.promptGap, true);
        this.busyUntil = Math.max(this.busyUntil, at);
        this.dataLeft = n;
        this.dataBuf = "";
        this.promptSeen = false;
        this.onData = fn;
    }

    // -- Port --

    write(data) {
        this.written += data;
        let s = data;
        while (s.length > 0) {
            if (this.dataLeft > 0) {
                if (!this.promptSeen) this.violations.push(`data written before '>' was read: ${JSON.stringify(s.slice(0, 20))}`);
                const take = s.slice(0, this.dataLeft);
                this.dataBuf += take;
                this.dataLeft -= take.length;
                s = s.slice(take.length);
                if (this.dataLeft === 0) {
                    const fn = this.onData;
                    this.onData = null;
                    this.received.push(this.dataBuf);
                    fn(this.dataBuf);
                }
                continue;
            }
            this.inbuf += s;
            s = "";
            let i;
            while ((i = this.inbuf.indexOf("\r\n")) >= 0) {
                const line = this.inbuf.slice(0, i);
                this.inbuf = this.inbuf.slice(i + 2);
                this.command(line);
                if (this.dataLeft > 0) {
                    // the rest of this write is payload
                    s = this.inbuf;
                    this.inbuf = "";
                    break;
                }
            }
        }
    }

    read() {
        this.deliver();
        if (this.avail.length === 0) return "";
        let n = this.avail.length;
        if (this.split) {
            // Half the time tiny pieces (splits headers, CRLF pairs, "SEND OK"),
            // otherwise anywhere.
            const r = this.split();
            n = r < 0.5 ? 1 + Math.floor(this.split() * Math.min(8, n)) : 1 + Math.floor(this.split() * n);
        }
        const out = this.avail.slice(0, n);
        this.avail = this.avail.slice(n);
        this.readTotal += out.length;
        if (this.promptOffset >= 0 && this.readTotal > this.promptOffset) this.promptSeen = true;
        return out;
    }

    // -- internals --

    command(line) {
        this.log.push(line);
        if (this.echo) this.emit(line + "\r\r\n", 0);
        if (this.clock.t < this.busyUntil) {
            this.busyRejected++;
            this.emit("busy p...\r\n", 1);
            return;
        }
        for (let i = this.handlers.length - 1; i >= 0; i--) {
            const [m, fn] = this.handlers[i];
            let hit = null;
            if (typeof m === "string") hit = m === line ? [line] : null;
            else if (m instanceof RegExp) hit = m.exec(line);
            else hit = m(line) ? [line] : null;
            if (hit) { fn(line, hit, this); return; }
        }
        // unknown command: no answer at all (the engine must time out)
    }

    arrive(text, prompt) {
        for (let i = 0; i < text.length; i++) {
            if (this.baud && this.avail.length >= this.rxCap) { this.overflow++; continue; }
            if (prompt && text[i] === ">") this.promptOffset = this.delivered;
            this.avail += text[i];
            this.delivered++;
        }
    }

    deliver() {
        const now = this.clock.t;
        if (!this.baud) {
            while (this.sched.length && this.sched[0].at <= now) {
                const it = this.sched.shift();
                this.arrive(it.text, it.prompt);
            }
            return;
        }
        const msPerByte = 10000 / this.baud; // 8N1: 10 bits per byte
        while (this.sched.length) {
            const it = this.sched[0];
            if (it.start === undefined) { it.start = Math.max(it.at, this.wireFree); it.sent = 0; }
            if (it.start > now) break;
            const arrived = Math.min(it.text.length, Math.floor((now - it.start) / msPerByte));
            if (arrived > it.sent) {
                this.arrive(it.text.slice(it.sent, arrived), it.prompt);
                it.sent = arrived;
            }
            if (it.sent < it.text.length) break;
            this.wireFree = it.start + it.text.length * msPerByte;
            this.sched.shift();
        }
    }
}

/** Default behaviour: the captured ESP32-C3 / ESP-AT 3.3 answers. */
function installDefaults(f) {
    const lines = (arr) => arr.map((l) => l + "\r\n").join("");
    f.on("AT", () => f.reply(["OK\r\n"]));
    f.on("ATE0", () => { f.echo = false; f.reply(["OK\r\n"]); });
    f.on("ATE1", () => { f.echo = true; f.reply(["OK\r\n"]); });
    f.on("AT+GMR", () => f.reply([[3, lines(GMR_ESP32C3)]]));
    f.on(/^AT\+CWJAP=/, () => f.reply([
        [120, "WIFI DISCONNECT\r\n"],
        [900, "WIFI CONNECTED\r\n"],
        [1600, "WIFI GOT IP\r\n"],
        [1700, "\r\nOK\r\n"],
    ]));
    f.on("AT+CWSTATE?", () => f.reply(['+CWSTATE:2,"Werkstatt-WLAN"\r\n\r\nOK\r\n']));
    f.on("AT+CIPRECVMODE?", () => f.reply([`+CIPRECVMODE:${f.recvMode}\r\n\r\nOK\r\n`]));
    f.on(/^AT\+CIPRECVMODE=([01])$/, (l, m) => { f.recvMode = +m[1]; f.reply(["OK\r\n"]); });
    f.on("AT+CWAUTOCONN?", () => f.reply(["+CWAUTOCONN:1\r\nOK\r\n"]));
    f.on("AT+UART_CUR?", () => f.reply(["+UART_CUR:115201,8,1,0,1\r\n\r\nOK\r\n"]));
    f.on("AT+HTTPCLIENT=?", () => f.reply(["ERROR\r\n"]));
    f.on(/^AT\+HTTPCLIENT=2,0,"https:\/\/campus-api\.calliope\.cc\/api\/health",,,2$/, () =>
        f.reply([[1300, `+HTTPCLIENT:${HEALTH_BODY.length},${HEALTH_BODY}\r\nOK\r\n`]]));
    f.on(/^AT\+CIPSTART="TCP","[^"]+",\d+$/, () => f.reply([[40, "CONNECT\r\n\r\nOK\r\n"]]));
    f.on(/^AT\+CIPSEND=(\d+)$/, (l, m) => {
        const n = +m[1];
        f.prompt(n, () => {
            f.reply([[2, `Recv ${n} bytes\r\n\r\nSEND OK\r\n`]]);
            const resp = f.response;
            if (f.recvMode === 0) {
                f.emit(`\r\n+IPD,${resp.length}:${resp}`, 60);
            } else {
                f.passiveBuf += resp;
                f.emit(`+IPD,${resp.length}\r\n`, 60);
            }
            f.emit("CLOSED\r\n", 400);
        });
    });
    f.on(/^AT\+CIPRECVDATA=(\d+)$/, (l, m) => {
        const k = Math.min(+m[1], f.passiveBuf.length);
        const bite = f.passiveBuf.slice(0, k);
        f.passiveBuf = f.passiveBuf.slice(k);
        // Measured on ESP-AT 3.3.0.0 (2026-10-08): after a partial pull the
        // module re-announces what is LEFT (+IPD,461 -> +IPD,261 -> +IPD,61),
        // i.e. the remaining total, not new data.
        const rest = f.passiveBuf.length;
        // Sent with the reply (the real module did not answer the next pull
        // with "busy"), so the fake is idle again when the next command comes.
        f.reply([[3, `+CIPRECVDATA:${k},${bite}\r\nOK\r\n` + (rest > 0 ? `+IPD,${rest}\r\n` : "")]]);
    });
    f.on(/^AT\+HTTPCPOST="([^"]+)",(\d+),1,"Content-Type: application\/json"$/, (l, m) => {
        f.prompt(+m[2], () => {
            // Raw CRLF + result words inside on purpose: framing, not content, must end the payload.
            const body = '{"cur":6131,"n":1,"ok":1,"note":"\r\nSEND OK\r\nERROR\r\n>","pad":"';
            let b = body;
            while (b.length < 225) b += "x";
            b += '"}';
            f.reply([[1200, `+HTTPCPOST:${b.length},${b}\r\n`], [1201, "SEND OK\r\n"]]);
        });
    });
}
