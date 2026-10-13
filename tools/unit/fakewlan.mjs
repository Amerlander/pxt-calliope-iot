// The `iotwlan` shim API (wlanshims.ts) emulated on the TS reference engine
// (wlanat.ts) and a FakeEsp, plus a rig that loads wlanclient.ts with it and
// runs the client's background fiber cooperatively on the fake clock.
//
// The engine is loaded separately from the client (its namespace is also
// called iotwlan); the client only ever sees the facade below, which returns
// what the C++ shims return: numeric result codes, kind + 256 * value URCs,
// flags + 256 * family + 65536 * major from detect().

import { loadExtension, makeShims } from "./loader.mjs";
import { Clock, FakeEsp } from "./fakeesp.mjs";
import { FakeNet } from "./fakenet.mjs";

const ENGINE = loadExtension();

const CODES = { OK: 0, ERROR: 1, FAIL: 2, TIMEOUT: 3, BUSY: 4 };

/** URC line -> kind | value << 8, as Engine::urcKind / takeUrc in wlanat.cpp. */
export function urcCode(line) {
    if (line.startsWith("WIFI ")) {
        if (line === "WIFI CONNECTED") return 2;
        if (line === "WIFI GOT IP") return 3;
        if (line.startsWith("WIFI DISCONNECT")) return 4;
        return 1;
    }
    if (line.startsWith("busy")) return 8 | ((line.charCodeAt(5) || 0) << 8);
    if (line.startsWith("+IPD,")) {
        const len = parseInt(line.slice(line.lastIndexOf(",") + 1), 10) || 0;
        return 9 | (len << 8);
    }
    if (line.startsWith("+")) return 1;
    if (line === "ready") return 7;
    let id = 0;
    let s = line;
    if (/^\d,/.test(line)) {
        id = +line[0];
        s = line.slice(2);
    }
    if (s === "CONNECT") return 5 | (id << 8);
    if (s === "CLOSED" || s === "CONNECT FAIL") return 6 | (id << 8);
    return 1;
}

/** The C++ port's limits on mini 3 (wlanport.cpp): payload buffer, receive ring, string cap. */
const IOT_PAYLOAD = 2048;
const IOT_MAX_STR = 2048;

export function makeIotwlan(clock, fake, opts = {}) {
    const at = new ENGINE.AtEngine(fake, clock.now, clock.sleep);
    at.maxPayload = opts.maxPayload ?? IOT_PAYLOAD;
    at.maxRecv = 2048;
    let last = null;
    let opened = false;
    const res = (r) => {
        last = r;
        return CODES[r.code];
    };
    const api = {
        engine: at,
        beginResult: opts.beginResult ?? 1,
        beginCalls: 0,
        begin(tx, rx, baud) {
            api.beginCalls++;
            if (clock.t < 5000) clock.sleep(5000 - clock.t); // OPEN_NOT_BEFORE_MS
            if (api.beginResult > 0) opened = true;
            return api.beginResult;
        },
        command(cmd, timeoutMs) {
            if (!opened) return CODES.ERROR;
            return res(at.command(cmd, timeoutMs));
        },
        sendData(cmd, data, timeoutMs) {
            if (!opened) return CODES.ERROR;
            return res(at.sendWithPrompt(cmd, data, timeoutMs));
        },
        resultFlags() {
            return last ? (last.sent ? 1 : 0) | (last.reset ? 2 : 0) | (last.truncated ? 4 : 0) : 0;
        },
        lineCount: () => (last ? last.lines.length : 0),
        line: (i) => (last && last.lines[i]) || "",
        findLine: (p) => (last ? last.line(p) : ""),
        payloadLength: () => (last ? last.payload.length : 0),
        payload(offset, max) {
            const p = last ? last.payload : "";
            if (offset < 0 || offset >= p.length || max <= 0) return "";
            return p.substr(offset, Math.min(max, IOT_MAX_STR));
        },
        recvAvailable() {
            at.pump();
            return at.recvAvailable();
        },
        recvTake: (max) => at.recvTake(Math.min(max, IOT_MAX_STR)),
        waitRecv: (minBytes, timeoutMs) => at.waitRecv(minBytes, timeoutMs),
        takeUrc() {
            if (!opened) return 0;
            at.pump();
            const u = at.takeUrc();
            return u.length ? urcCode(u) : 0;
        },
        status() {
            if (!opened) return 0;
            at.pump();
            return (at.wifiConnected ? 1 : 0) | (at.wifiGotIp ? 2 : 0) | (at.linkOpen ? 4 : 0) | (at.echoOn ? 8 : 0) | 16;
        },
        detect(timeoutMs) {
            const c = at.detect(timeoutMs);
            const flags = (c.httpClient ? 1 : 0) | (c.passiveRecv ? 2 : 0) | (c.tls ? 4 : 0) | (c.sysstore ? 8 : 0);
            return flags | (c.family << 8) | ((c.major < 0 ? 255 : c.major & 255) << 16);
        },
        moduleInfo: (w) => (w === 0 ? at.caps.version : w === 1 ? at.caps.chip : w === 2 ? at.caps.bin : ""),
        wake: (attempts, perTryMs) => opened && at.sync(attempts, perTryMs),
        echoOff: (timeoutMs) => at.disableEcho(timeoutMs),
        pumpFor: (ms) => at.pumpFor(ms),
        /** raw writes, for the recovery tests: { t, data } */
        raws: [],
        writeRaw(data) {
            if (!opened || at.isBusy()) return false;
            api.raws.push({ t: clock.t, data });
            fake.write(data);
            // the C++ port blocks until the bytes are queued: 115200 baud, 8N1
            clock.sleep(Math.ceil((data.length * 10) / 115.2));
            return true;
        },
        stats(which) {
            switch (which) {
                case 0: return at.passivePending;
                case 1: return at.resets;
                case 2: return at.busyCount;
                case 3: return at.staleFinals;
                case 4: return at.lost;
                case 6: return 1;
                case 7: return at.urcCount();
                case 9: return fake.readTotal; // bytes the engine read from the port
                default: return 0;
            }
        },
        configure() { },
    };
    return api;
}

/**
 * A mini with the WLAN client loaded. `run(ms)` lets fake time pass with the
 * background fiber running; basic.pause() from the "main fiber" (waitOnline,
 * the lock) does the same. Clock hooks (clock.at) act as further fibers.
 */
export function wifiRig(opts = {}) {
    const clock = new Clock();
    const fake = new FakeEsp(clock, { echo: true });
    const cmds = [];
    const command = fake.command.bind(fake);
    fake.command = (line) => {
        cmds.push({ t: clock.t, line });
        command(line);
    };
    const net = new FakeNet(fake, clock, opts);
    const wlan = makeIotwlan(clock, fake, opts);

    let X = null;
    let bgStarted = false;
    let bgNext = 0;
    let inBg = false;
    const states = [];
    const bgStep = () => {
        inBg = true;
        const w = X.iotwifi.step();
        inBg = false;
        const s = X.iotwifi.state();
        if (states[states.length - 1] !== s) states.push(s);
        bgNext = clock.t + Math.max(1, w);
    };
    const pause = (ms) => {
        if (inBg || !bgStarted) {
            clock.sleep(ms);
            return;
        }
        const end = clock.t + Math.max(0, ms);
        do {
            if (clock.t >= bgNext) bgStep();
            const until = Math.min(end, bgNext);
            if (until > clock.t) clock.sleep(until - clock.t);
        } while (clock.t < end);
    };
    const shims = makeShims({
        iotwlan: wlan,
        control: {
            millis: () => clock.t,
            inBackground: () => {
                bgStarted = true;
                bgNext = clock.t;
            },
        },
        basic: { pause },
    });
    X = loadExtension(["iottypes.ts", "wlanclient.ts"], shims, "{ iotcore, iotwifi }");
    const k = {
        clock, fake, net, wlan, cmds, states, X,
        wifi: X.iotwifi,
        core: X.iotcore,
        run: (ms) => pause(ms),
        /** command lines sent since index `from` */
        lines: (from = 0) => cmds.slice(from).map((c) => c.line),
        connect(ssid = net.ap.ssid, pw = net.ap.pw) {
            X.iotwifi.connect(ssid, pw, 117, 116);
        },
        online(timeout = 60000) {
            k.connect();
            return X.iotwifi.waitOnline(timeout);
        },
        batch(seq = 1, n = 2) {
            const b = new X.iotcore.Batch();
            b.seq = seq;
            for (let i = 0; i < n; i++) {
                b.feeds.push(i === 0 ? "temp" : "text" + i);
                b.values.push(i === 0 ? "21.5" : `"hallo ${i}"`);
                b.tos.push(i === 1 ? "0" : "");
                b.ages.push(1000 * (n - i));
            }
            return b;
        },
        ctx(server = "http://192.168.1.172:8090/api/iot/v1", since = 0) {
            const c = new X.iotcore.IngestContext();
            c.ref = "W-TEST-TEST-TEST";
            c.server = server;
            c.dev = "2656000046";
            c.scope = "a";
            c.since = since;
            c.boot = "b0123";
            return c;
        },
        post(b, c) {
            return X.iotwifi.postIngest(b, c);
        },
    };
    return k;
}

/** Plain, comparable view of an Answer. */
export function plain(a) {
    return {
        ok: a.ok, dup: a.dup, error: a.error, retryAfterMs: a.retryAfterMs, serverSec: a.serverSec, tzoMin: a.tzoMin,
        cur: a.cur, more: a.more, dFeeds: a.dFeeds.slice(), dValues: a.dValues.slice(), dFroms: a.dFroms.slice(), dTos: a.dTos.slice(),
    };
}
