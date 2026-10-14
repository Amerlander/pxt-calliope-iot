// Network side of the fake module for the WLAN client tests: an access point,
// the module's join/status commands, TCP/SSL links, AT+HTTPCPOST, and a small
// model of the PocketBase ingest route (pocketbase/pb_hooks/iot.pb.js).
//
// Installs extra handlers on a FakeEsp (later handlers win, so the defaults
// in fakeesp.mjs stay untouched). Wire strings are byte strings: one char per
// UART byte; the server answers like Go's encoder (keys sorted, non-ASCII as
// raw UTF-8 bytes).

import { GMR_ESP8266_AT1 } from "./fakeesp.mjs";

/** JS (UTF-16) text -> UTF-8 byte string, as it travels over the UART. */
export const wire = (s) => Buffer.from(s, "utf8").toString("latin1");
/** UTF-8 byte string -> JS text. */
export const unwire = (b) => Buffer.from(b, "latin1").toString("utf8");

/** Go-style JSON: keys sorted, <>& escaped, non-ASCII as raw UTF-8 bytes. */
export function goJson(v) {
    const sortKeys = (x) => Array.isArray(x) ? x.map(sortKeys)
        : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])]))
        : x;
    const text = JSON.stringify(sortKeys(v)).replace(/[<>&]/g, (c) => "\\u00" + c.charCodeAt(0).toString(16));
    return wire(text) + "\n"; // json.Encoder ends with a newline
}

/** AT string parameters after '=' with \" \, \\ unescaped: 'a\"b",x' -> ['a"b', 'x']. */
export function atParams(s) {
    const out = [];
    let i = 0;
    while (i < s.length) {
        if (s[i] === '"') {
            let v = "";
            i++;
            while (i < s.length && s[i] !== '"') {
                if (s[i] === "\\" && i + 1 < s.length) i++;
                v += s[i++];
            }
            i++;
            out.push(v);
        } else {
            let j = s.indexOf(",", i);
            if (j < 0) j = s.length;
            out.push(s.slice(i, j));
            i = j;
        }
        if (s[i] === ",") i++;
    }
    return out;
}

/** The ingest route, reduced to what a device sees. */
export class FakeServer {
    constructor(clock, opts = {}) {
        this.clock = clock;
        this.tokens = opts.tokens ?? ["W-TEST-TEST-TEST"];
        this.minInterval = opts.minInterval ?? 900;
        this.hw = opts.hw ?? 100;   // high water mark of seq
        this.points = [];           // { seq, f, v, from, to }
        this.lastAt = new Map();    // dev -> ms of the last accepted batch
        this.lastBatch = new Map(); // dev -> { boot, s }
        this.requests = [];         // parsed request bodies
        this.chunked = !!opts.chunked;
    }

    /** A point written by someone else (dashboard "0" or another device). */
    write(from, f, v, to = "") {
        this.points.push({ seq: ++this.hw, f, v, from, to });
    }

    /** Request body (byte string) -> { status, body (byte string) }. */
    handle(bytes) {
        const nowMs = this.clock.t;
        let body;
        try {
            body = JSON.parse(unwire(bytes));
        } catch {
            return { status: 400, body: goJson({ ok: 0, error: "bad_json" }) };
        }
        this.requests.push(body);
        const tok = String(body.t || "").toUpperCase().split(":").find((p) => p.startsWith("W-"));
        if (!tok) return { status: 401, body: goJson({ ok: 0, error: "no_write_token" }) };
        if (!this.tokens.includes(tok)) return { status: 401, body: goJson({ ok: 0, error: "bad_token" }) };
        const dev = String(body.dev || "0");
        if (!/^-?[0-9]{1,20}$/.test(dev)) return { status: 400, body: goJson({ ok: 0, error: "bad_device" }) };
        const last = this.lastAt.get(dev) ?? -1e9;
        if (nowMs - last < this.minInterval) {
            const retryAfter = Math.ceil((this.minInterval - (nowMs - last)) / 1000);
            return { status: 429, body: goJson({ ok: 0, error: "too_fast", retry_after: retryAfter }) };
        }
        this.lastAt.set(dev, nowMs);
        const s = Math.floor(Number(body.s || 0));
        const boot = String(body.boot || "");
        const prev = this.lastBatch.get(dev);
        const dup = s > 0 && boot !== "" && prev && prev.boot === boot && s <= prev.s;
        let n = 0;
        if (!dup) {
            for (const p of body.d || []) {
                this.points.push({ seq: ++this.hw, f: String(p.f).toLowerCase(), v: p.v, from: dev, to: p.to || "" });
                n++;
            }
            if (s > 0) this.lastBatch.set(dev, { boot, s });
        }
        const since = body.since === undefined ? -1 : Math.floor(Number(body.since));
        const visible = (p) => p.from !== dev && (p.to === "" || p.to === dev);
        const answer = { ok: 1, ts: 1760000000 + Math.floor(nowMs / 1000), tzo: 120, n, rej: 0, w: [] };
        if (since > 0) {
            const rows = this.points.filter((p) => p.seq > since && visible(p));
            const take = rows.slice(0, 8);
            answer.w = take.map((p) => ({ f: p.f, v: p.v, from: p.from, to: p.to }));
            answer.cur = rows.length > 8 ? take[take.length - 1].seq : this.hw;
            if (rows.length > 8) answer.more = 1;
        } else {
            const lastPer = new Map();
            for (const p of this.points) if (visible(p)) lastPer.set(p.f + "|" + p.from + "|" + p.to, p);
            answer.w = [...lastPer.values()].slice(-32).map((p) => ({ f: p.f, v: p.v, from: p.from, to: p.to }));
            if (since === 0) answer.cur = this.hw;
        }
        if (dup) answer.dup = 1;
        return { status: 200, body: goJson(answer) };
    }

    /** The same answer as a raw HTTP/1.1 response (what CIPSTART/CIPSEND receives). */
    http(status, body) {
        const reason = { 200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 429: "Too Many Requests" }[status] || "Error";
        let head = `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nDate: Tue, 13 Oct 2026 10:00:00 GMT\r\n`;
        if (this.chunked) {
            let chunks = "";
            for (let i = 0; i < body.length; i += 100) {
                const c = body.slice(i, i + 100);
                chunks += c.length.toString(16) + "\r\n" + c + "\r\n";
            }
            return head + "Connection: close\r\nTransfer-Encoding: chunked\r\n\r\n" + chunks + "0\r\n\r\n";
        }
        return head + `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n` + body;
    }
}

const GMR_AT20 = [
    "AT version:2.0.0.0(4ecd5b1 - ESP32 - Jan  1 2020 00:00:00)",
    "SDK version:v3.3.2",
    "compile time:Jan  1 2020 00:00:00",
    "Bin version:2.0.0(WROOM-32)",
    "",
    "OK",
];

const BSSID = "5c:49:79:2a:10:01";

/**
 * opts.family  "esp32" (ESP32-C3, ESP-AT 3.3; default) | "at20" (ESP-AT 2.0: TLS, passive, no HTTP client) | "at1"
 * opts.ssid / opts.pw   the access point; opts.joined: SSID the module is on at start (null)
 * opts.httpcMode  what AT+HTTPCPOST does on a non-2xx answer:
 *     "body-fail" (framed body, SEND FAIL; default), "body-ok", "nobody-fail", "errcode"
 * opts.latency  ms from the end of the POST body to the answer (default 1200)
 * opts.segment  active mode: bytes per +IPD frame
 */
export class FakeNet {
    constructor(f, clock, opts = {}) {
        this.f = f;
        this.clock = clock;
        this.family = opts.family ?? "esp32";
        this.ap = { ssid: opts.ssid ?? "Klasse 4b", pw: opts.pw ?? "geheim", present: true, outcome: "" };
        this.joined = opts.joined ?? null;
        this.server = opts.server ?? new FakeServer(clock, opts);
        this.httpcMode = opts.httpcMode ?? "body-fail";
        this.latency = opts.latency ?? 1200;
        this.segment = opts.segment ?? 1460;
        this.rssi = opts.rssi ?? -58;
        this.hosts = { "192.168.1.172": true, "campus-api.calliope.cc": true };
        this.link = null;
        this.joins = [];    // { t, ssid, pw }
        this.posts = [];    // { t, url, body } (HTTPCPOST)
        this.sends = [];    // { t, data, link } (CIPSEND)
        this.responses = []; // raw HTTP responses sent back over a link
        // recovery modes (see the wedge methods below)
        this.blankLines = opts.blankLines ?? "ignore"; // "ignore" | "error": what an empty line gets
        this.mode = "";
        this.tx = [];        // every write to the module: { t, data }
        this.lastTx = -1e9;
        this.plus = null;
        this.plusExits = 0;
        this.swallowed = 0;
        this.unwedged = null;
        this.wrapWrite();
        this.install();
    }

    // ---- a module left in a bad state (it keeps its power across a Calliope reset) ----

    /**
     * Still waiting for `n` bytes of an AT+CIPSEND=<n> / AT+HTTPCPOST whose
     * sender was reset after the '>': everything written is payload until n
     * arrived ("AT\r\n" included), so nothing is answered.
     */
    wedgePrompt(n, kind = "cipsend") {
        const f = this.f;
        f.dataLeft = n;
        f.dataBuf = "";
        f.promptSeen = true;
        f.onData = (data) => {
            this.unwedged = { t: this.clock.t, data };
            // CIPSEND: the link may be long gone; HTTPCPOST: posts the garbage, busy meanwhile
            if (kind === "httpcpost") f.reply([[900, "SEND FAIL\r\n"]]);
            else f.reply([[2, `\r\nRecv ${n} bytes\r\n\r\nSEND FAIL\r\n`]]);
        };
    }

    /** Transparent mode (CIPMODE=1 + CIPSEND): all bytes go to the link; a lone "+++" with 1 s silence around it leaves. */
    wedgeTransparent() {
        this.mode = "transparent";
        this.lastTx = this.clock.t;
    }

    /** Hung or crashed: takes every byte, answers none. */
    silence() {
        this.mode = "silent";
    }

    /** Alive, but every command answers ERROR; AT+RST brings it back. */
    wedgeErroring() {
        this.mode = "erroring";
        this.errBuf = "";
    }

    /** Noise for every write (boot loop, wrong baud rate): bytes come back, nothing is understood. */
    noise() {
        this.mode = "noise";
    }

    wrapWrite() {
        const f = this.f;
        const write = f.write.bind(f);
        f.write = (data) => {
            const now = this.clock.t;
            this.tx.push({ t: now, data });
            const m = this.mode;
            if (m === "transparent") {
                // any byte within 1 s after "+++" cancels it
                this.plus = null;
                if (data === "+++" && now - this.lastTx >= 1000) {
                    const p = { at: now };
                    this.plus = p;
                    this.clock.at(now + 1000, () => {
                        if (this.plus !== p) return;
                        this.plus = null;
                        this.mode = "";
                        this.plusExits++;
                    });
                }
                this.lastTx = now;
                this.swallowed += data.length;
                return;
            }
            if (m === "silent") {
                this.swallowed += data.length;
                return;
            }
            if (m === "noise") {
                this.swallowed += data.length;
                f.emit("\xfe\x80\x00\xf8", 3);
                return;
            }
            if (m === "erroring") {
                this.errBuf += data;
                let i;
                while ((i = this.errBuf.indexOf("\r\n")) >= 0) {
                    const line = this.errBuf.slice(0, i);
                    this.errBuf = this.errBuf.slice(i + 2);
                    if (line === "AT+RST") {
                        this.mode = "";
                        f.emit("OK\r\n", 2);
                        this.reboot(400);
                        return;
                    }
                    if (line !== "") f.emit("ERROR\r\n", 2);
                }
                return;
            }
            write(data);
        };
    }

    // ---- what the tests do to the world ----

    /** The AP goes away (or the module loses it): WIFI DISCONNECT. */
    dropWifi() {
        this.joined = null;
        this.link = null;
        this.f.emit("WIFI DISCONNECT\r\n", 1);
    }

    /** The module reconnects on its own (ESP-AT reconn_interval). */
    autoReconnect(ms = 500) {
        this.joined = this.ap.ssid;
        this.f.emit("WIFI CONNECTED\r\n", ms);
        this.f.emit("WIFI GOT IP\r\n", ms + 400);
    }

    /** Brown-out / watchdog: the module reboots and forgets everything. */
    reboot(ms = 300) {
        this.joined = null;
        this.radioOff = false; // SYSSTORE=0: the mode from flash (station) comes back
        this.link = null;
        this.f.passiveBuf = "";
        this.f.recvMode = 0;
        this.f.echo = true;
        this.f.emit("\r\nready\r\n", ms);
    }

    // ---- module commands ----

    install() {
        const f = this.f;
        const ok = () => f.reply(["OK\r\n"]);
        const err = () => f.reply(["ERROR\r\n"]);
        // unknown commands: ERROR, like the firmware (the default fake stays silent);
        // empty lines (recovery filler) get nothing unless blankLines = "error"
        f.handlers.unshift([() => true, (line) => {
            if (line !== "" || this.blankLines === "error") err();
        }]);
        const fam = this.family;
        const at1 = fam === "at1";
        const lines = (arr) => arr.map((l) => l + "\r\n").join("");

        if (at1) {
            f.on("AT+GMR", () => f.reply([[3, lines(GMR_ESP8266_AT1)]]));
            for (const c of ["AT+CWSTATE?", "AT+CWMODE=1", "AT+SYSSTORE=0", "AT+SYSLOG=1"]) f.on(c, err);
            f.on(/^AT\+CIPRECVMODE/, err);
            f.on(/^AT\+HTTPC/, err);
            f.on(/^AT\+CWJAP=/, err);
            f.on("AT+CWMODE_CUR=1", ok);
            f.on(/^AT\+CWJAP_CUR=(.*)$/, (l, m) => this.join(atParams(m[1]), true));
            f.on("AT+CWJAP_CUR?", () => f.reply([[2, this.joined
                ? `+CWJAP_CUR:"${this.joined}","${BSSID}",6,${this.rssi}\r\n\r\nOK\r\n` : "No AP\r\n\r\nOK\r\n"]]));
        } else {
            if (fam === "at20") f.on("AT+GMR", () => f.reply([[3, lines(GMR_AT20)]]));
            f.on("AT+SYSSTORE=0", ok);
            f.on("AT+CWMODE=1", ok);
            f.on("AT+SYSLOG=1", ok);
            f.on("AT+SLEEP=1", ok);
            f.on(/^AT\+CIPSSLCSNI=/, ok);
            f.on(/^AT\+CWJAP=(.*)$/, (l, m) => this.join(atParams(m[1]), false));
            f.on("AT+CWSTATE?", () => f.reply([`+CWSTATE:${this.joined ? 2 : 0},"${this.joined ?? ""}"\r\n\r\nOK\r\n`]));
            f.on("AT+CWJAP?", () => f.reply([[2, this.joined
                ? `+CWJAP:"${this.joined}","${BSSID}",6,${this.rssi},0,1,3,0,1\r\n\r\nOK\r\n` : "No AP\r\n\r\nOK\r\n"]]));
            f.on(/^AT\+HTTPCPOST="([^"]+)",(\d+),1,"Content-Type: application\/json"$/, (l, m) => this.httpcpost(m[1], +m[2]));
        }
        // Sleep: leave the network and switch the radio off; a join with the
        // radio off fails (the client switches it on first).
        f.on("AT+CWQAP", () => {
            const was = this.joined;
            this.joined = null;
            f.reply(was ? [[60, "WIFI DISCONNECT\r\n"], [80, "\r\nOK\r\n"]] : ["OK\r\n"]);
        });
        f.on(at1 ? "AT+CWMODE_CUR=0" : "AT+CWMODE=0", () => { this.radioOff = true; ok(); });
        f.on(at1 ? "AT+CWMODE_CUR=1" : "AT+CWMODE=1", () => { this.radioOff = false; ok(); });
        f.on("AT+CIPMUX=0", ok);
        f.on("AT+CIPMODE=0", ok);
        f.on("AT+CIPDINFO=0", ok);
        f.on("AT+RST", () => {
            f.reply(["OK\r\n"]);
            this.reboot(400);
        });
        f.on("AT+CIPSTATUS", () => f.reply([`STATUS:${this.joined ? (this.link ? 3 : 2) : 5}\r\n\r\nOK\r\n`]));
        f.on(/^AT\+CIPSTART="(TCP|SSL)","([^"]+)",(\d+)$/, (l, m) => this.cipstart(m[1], m[2], +m[3]));
        f.on(/^AT\+CIPSEND=(\d+)$/, (l, m) => this.cipsend(+m[1]));
        f.on(/^AT\+CIPRECVDATA=(\d+)$/, (l, m) => this.recvdata(+m[1]));
        f.on("AT+CIPCLOSE", () => {
            if (!this.link) return err();
            this.link = null;
            f.passiveBuf = "";
            f.reply(["CLOSED\r\n\r\nOK\r\n"]);
        });
    }

    join([ssid, pw], at1) {
        const f = this.f;
        this.joins.push({ t: this.clock.t, ssid, pw });
        const was = this.joined;
        const fail = (code, ms) => {
            this.joined = null;
            const steps = was ? [[120, "WIFI DISCONNECT\r\n"]] : [];
            steps.push([ms, at1 ? `+CWJAP_CUR:${code}\r\n\r\nFAIL\r\n` : `+CWJAP:${code}\r\n\r\nERROR\r\n`]);
            f.reply(steps);
        };
        if (this.radioOff) return f.reply(["ERROR\r\n"]);
        if (!this.ap.present || ssid !== this.ap.ssid) return fail(3, 3000);
        if (pw !== this.ap.pw) return fail(2, 4000);
        if (this.ap.outcome === "timeout") return fail(1, 15000);
        this.joined = ssid;
        const steps = was ? [[120, "WIFI DISCONNECT\r\n"]] : [];
        steps.push([900, "WIFI CONNECTED\r\n"], [1600, "WIFI GOT IP\r\n"], [1700, "\r\nOK\r\n"]);
        f.reply(steps);
    }

    httpcpost(url, len) {
        const f = this.f;
        f.prompt(len, (data) => {
            this.posts.push({ t: this.clock.t, url, body: data });
            const host = url.split("/")[2].split(":")[0];
            if (!this.joined || !this.hosts[host]) return f.reply([[2000, "ERR CODE:0x010a7000\r\nSEND FAIL\r\n"]]);
            const { status, body } = this.server.handle(data);
            let frames = "";
            for (let i = 0; i < body.length; i += 512) {
                const c = body.slice(i, i + 512);
                frames += `+HTTPCPOST:${c.length},${c}\r\n`;
            }
            const d = this.latency;
            if (status < 300) return f.reply([[d, frames], [d + 1, "SEND OK\r\n"]]);
            const mode = this.httpcMode;
            if (mode === "body-ok") f.reply([[d, frames], [d + 1, "SEND OK\r\n"]]);
            else if (mode === "body-fail") f.reply([[d, frames], [d + 1, "SEND FAIL\r\n"]]);
            else if (mode === "nobody-fail") f.reply([[d, "SEND FAIL\r\n"]]);
            else f.reply([[d, `ERR CODE:0x010a${(0x7000 + status).toString(16)}\r\nSEND FAIL\r\n`]]);
        });
    }

    cipstart(kind, host, port) {
        const f = this.f;
        if (this.link) return f.reply(["ALREADY CONNECTED\r\n\r\nERROR\r\n"]);
        if (!this.joined) return f.reply([[5, "no ip\r\n\r\nERROR\r\n"]]);
        if (!this.hosts[host]) return f.reply([[300, "DNS Fail\r\n\r\nERROR\r\n"]]);
        if (kind === "SSL" && this.family === "at1") return f.reply([[500, "ERROR\r\nCLOSED\r\n"]]);
        this.link = { kind, host, port, serverClosed: false };
        f.reply([[kind === "SSL" ? 900 : 40, "CONNECT\r\n\r\nOK\r\n"]]);
    }

    cipsend(n) {
        const f = this.f;
        if (!this.link) return f.reply(["link is not valid\r\n\r\nERROR\r\n"]);
        const link = this.link;
        f.prompt(n, (data) => {
            this.sends.push({ t: this.clock.t, data, link });
            f.reply([[2, `Recv ${n} bytes\r\n\r\nSEND OK\r\n`]]);
            const he = data.indexOf("\r\n\r\n");
            const { status, body } = this.server.handle(data.slice(he + 4));
            const resp = this.server.http(status, body);
            this.responses.push(resp);
            link.serverClosed = true;
            if (f.recvMode === 0) {
                let at = 60;
                for (let i = 0; i < resp.length; i += this.segment) {
                    const seg = resp.slice(i, i + this.segment);
                    f.emit(`\r\n+IPD,${seg.length}:${seg}`, at);
                    at += 5;
                }
                f.emit("CLOSED\r\n", at + 20);
                this.link = null;
            } else {
                // passive: announce the total; CLOSED only after the buffer is read
                f.passiveBuf += resp;
                f.emit(`+IPD,${f.passiveBuf.length}\r\n`, 60);
            }
        });
    }

    recvdata(max) {
        const f = this.f;
        if (f.passiveBuf.length === 0) return f.reply(["ERROR\r\n"]);
        const k = Math.min(max, f.passiveBuf.length);
        const bite = f.passiveBuf.slice(0, k);
        f.passiveBuf = f.passiveBuf.slice(k);
        const rest = f.passiveBuf.length;
        // re-announces the remaining total after a partial pull (measured, ESP-AT 3.3.0.0)
        let tail = rest > 0 ? `+IPD,${rest}\r\n` : "";
        if (rest === 0 && this.link && this.link.serverClosed) {
            tail += "CLOSED\r\n";
            this.link = null;
        }
        f.reply([[3, `+CIPRECVDATA:${k},${bite}\r\nOK\r\n` + tail]]);
    }
}
