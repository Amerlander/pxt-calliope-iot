// Unit tests for the AT engine (wlanat.ts) and the serial port (wlanport.ts).
// Run: npm test   (in tools/unit)

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadExtension, makeShims } from "./loader.mjs";
import {
    Clock, FakeEsp, rng, httpRequest, httpResponse,
    GMR_ESP32C3, GMR_ESP8266_AT1, HEALTH_BODY,
} from "./fakeesp.mjs";

const W = loadExtension();

function rig(opts = {}) {
    const clock = new Clock();
    const fake = new FakeEsp(clock, opts);
    const at = new W.AtEngine(fake, clock.now, clock.sleep);
    return { clock, fake, at };
}

/** Plain, comparable view of a result. */
function res(r) {
    return { code: r.code, lines: r.lines.slice(), payload: r.payload, sent: r.sent, reset: r.reset, truncated: r.truncated };
}

/** Drain the URC queue and snapshot the connection state. */
function state(at) {
    const urcs = [];
    for (let u = at.takeUrc(); u.length > 0; u = at.takeUrc()) urcs.push(u);
    return {
        urcs,
        wifiConnected: at.wifiConnected,
        wifiGotIp: at.wifiGotIp,
        linkOpen: at.linkOpen,
        passivePending: at.passivePending,
        echoOn: at.echoOn,
        resets: at.resets,
    };
}

const CIPSTART = 'AT+CIPSTART="TCP","192.168.1.172",8090';
const HTTPCPOST = (n) => `AT+HTTPCPOST="http://192.168.1.172:8090/api/iot/v1/ingest",${n},1,"Content-Type: application/json"`;
const HEALTH = 'AT+HTTPCLIENT=2,0,"https://campus-api.calliope.cc/api/health",,,2';

// ---------------------------------------------------------------------------
// Scenarios. Each returns a plain summary; the property test re-runs them with
// the module output split at random positions and expects identical summaries.
// ---------------------------------------------------------------------------

const scenarios = {
    basicCodes(k) {
        const out = {};
        out.ok = res(k.at.command("AT", 500));
        out.err = res(k.at.command("AT+HTTPCLIENT=?", 500));
        const t0 = k.clock.t;
        out.timeout = res(k.at.command("AT+NOSUCH", 300));
        out.timeoutTook = k.clock.t - t0 >= 300;
        out.state = state(k.at);
        return out;
    },

    echoErrorSsid(k) {
        // Echo is on (fresh module): the echoed line contains ERROR and OK.
        k.fake.on('AT+CWJAP="ERROR","OK"', (l, m, f) => f.reply([[800, "+CWJAP:1\r\n\r\nFAIL\r\n"]]));
        const out = {};
        out.join = res(k.at.command('AT+CWJAP="ERRORNET","pw"', 5000));
        out.afterJoin = state(k.at);
        out.fail = res(k.at.command('AT+CWJAP="ERROR","OK"', 5000));
        out.gmrWithEcho = res(k.at.command("AT+GMR", 1000));
        out.ate0 = k.at.disableEcho(500);
        out.gmr = res(k.at.command("AT+GMR", 1000));
        out.state = state(k.at);
        return out;
    },

    urcInterleaved(k) {
        k.fake.on("AT+GMR", (l, m, f) => f.reply([
            [2, GMR_ESP32C3[0] + "\r\n"],
            [3, "WIFI DISCONNECT\r\n"],
            [4, GMR_ESP32C3[1] + "\r\n" + GMR_ESP32C3[2] + "\r\n"],
            [5, "0,CLOSED\r\n"],
            [6, GMR_ESP32C3[3] + "\r\n"],
            [7, "WIFI CONNECTED\r\nWIFI GOT IP\r\n"],
            [8, "\r\nOK\r\n"],
        ]));
        k.at.command("ATE0", 500);
        const out = { gmr: res(k.at.command("AT+GMR", 1000)) };
        out.state = state(k.at);
        return out;
    },

    busyRetry(k) {
        k.at.command("ATE0", 500);
        // A long command (e.g. CWJAP) is still running; its OK arrives later.
        k.fake.busyUntil = k.clock.t + 600;
        k.fake.emit("OK\r\n", 550);
        // Our own answer takes a while, so a wrongly accepted stale OK would
        // end the transaction before it arrives.
        k.fake.on("AT+CWSTATE?", (l, m, f) => f.reply([[20, '+CWSTATE:2,"Werkstatt-WLAN"\r\n\r\nOK\r\n']]));
        const out = { st: res(k.at.command("AT+CWSTATE?", 1000)) };
        out.sends = k.fake.log.filter((l) => l === "AT+CWSTATE?").length;
        out.stale = k.at.staleFinals;
        out.state = state(k.at);
        return out;
    },

    staleAfterTimeout(k) {
        k.at.command("ATE0", 500);
        k.fake.on("AT+SLOW", (l, m, f) => f.reply([[500, "+SLOW:1\r\n\r\nOK\r\n"]]));
        const out = {};
        out.slow = res(k.at.command("AT+SLOW", 100));
        out.next = res(k.at.command("AT+CWSTATE?", 2000));
        // Second case: the late reply lands in the RX buffer while nobody
        // pumps (the program is busy elsewhere) and is still there when the
        // next command goes out. The pre-command drain must discard it.
        k.fake.on("AT+SLOW2", (l, m, f) => f.reply([[150, "+SLOW:2\r\n\r\nOK\r\n"]]));
        k.fake.on("AT+CWSTATE?", (l, m, f) => f.reply([[20, '+CWSTATE:2,"Werkstatt-WLAN"\r\n\r\nOK\r\n']]));
        out.slow2 = res(k.at.command("AT+SLOW2", 100));
        k.clock.sleep(100);
        out.next2 = res(k.at.command("AT+CWSTATE?", 2000));
        out.stale = k.at.staleFinals;
        out.state = state(k.at);
        return out;
    },

    cipsendActive(k) {
        k.at.command("ATE0", 500);
        const req = httpRequest(283);
        const out = {};
        out.start = res(k.at.command(CIPSTART, 5000));
        out.linkAfterStart = k.at.linkOpen;
        out.send = res(k.at.sendWithPrompt("AT+CIPSEND=283", req, 5000));
        out.reqIntact = k.fake.received[0] === req;
        out.gotAll = k.at.waitRecv(1223, 3000);
        out.data = k.at.recvTake(-1);
        out.dataIntact = out.data === k.fake.response;
        k.at.pumpFor(600);
        out.violations = k.fake.violations.slice();
        out.state = state(k.at);
        return out;
    },

    cipsendPassive(k, bite = 128) {
        k.fake.response = httpResponse(464);
        k.at.command("ATE0", 500);
        const out = {};
        out.mode = res(k.at.command("AT+CIPRECVMODE=1", 500));
        out.start = res(k.at.command(CIPSTART, 5000));
        out.send = res(k.at.sendWithPrompt("AT+CIPSEND=283", httpRequest(283), 5000));
        k.at.pumpFor(100);
        out.pendingAfterNotify = k.at.passivePending;
        out.bites = [];
        let body = "";
        while (k.at.passivePending > 0 && out.bites.length < 10) {
            const r = k.at.command(`AT+CIPRECVDATA=${bite}`, 1000);
            out.bites.push({ code: r.code, len: r.payload.length, lines: r.lines.slice() });
            body += r.payload;
        }
        out.bodyIntact = body === k.fake.response;
        k.at.pumpFor(600);
        out.recvBuffered = k.at.recvAvailable();
        out.violations = k.fake.violations.slice();
        out.state = state(k.at);
        return out;
    },

    httpcpost(k) {
        k.at.command("ATE0", 500);
        const body = '{"d":123456,"p":[["temp",21.5]],"boot":7,"s":1}';
        const r = k.at.sendWithPrompt(HTTPCPOST(body.length), body, 5000);
        return {
            post: res(r),
            bodyIntact: k.fake.received[0] === body,
            violations: k.fake.violations.slice(),
            state: state(k.at),
        };
    },

    httpclient(k) {
        k.at.command("ATE0", 500);
        return { get: res(k.at.command(HEALTH, 5000)), state: state(k.at) };
    },

    gmrDetect(k) {
        k.at.command("ATE0", 500);
        const c = k.at.detect(1000);
        return { family: c.family, version: c.version, major: c.major, minor: c.minor, chip: c.chip, bin: c.bin,
            httpClient: c.httpClient, passiveRecv: c.passiveRecv, tls: c.tls, sysstore: c.sysstore };
    },
};

// ---------------------------------------------------------------------------

test("OK, ERROR and TIMEOUT", () => {
    const k = rig();
    const s = scenarios.basicCodes(k);
    assert.deepEqual(s.ok, { code: "OK", lines: [], payload: "", sent: false, reset: false, truncated: false });
    assert.equal(s.err.code, "ERROR");
    assert.equal(s.timeout.code, "TIMEOUT");
    assert.ok(s.timeoutTook);
    assert.deepEqual(s.state.urcs, []);
});

test("echo before ATE0: an SSID containing ERROR is not a result code", () => {
    const k = rig();
    const s = scenarios.echoErrorSsid(k);
    assert.equal(s.join.code, "OK");
    assert.deepEqual(s.join.lines, [], "the echoed command line must not show up as an info line");
    assert.deepEqual(s.afterJoin.urcs, ["WIFI DISCONNECT", "WIFI CONNECTED", "WIFI GOT IP"]);
    assert.equal(s.afterJoin.wifiGotIp, true);
    assert.equal(s.fail.code, "FAIL");
    assert.deepEqual(s.fail.lines, ["+CWJAP:1"]);
    assert.deepEqual(s.gmrWithEcho.lines, GMR_ESP32C3.slice(0, 4));
    assert.equal(s.ate0, true);
    assert.deepEqual(s.gmr.lines, GMR_ESP32C3.slice(0, 4));
    assert.equal(s.state.echoOn, false);
    assert.ok(k.fake.written.includes('AT+CWJAP="ERRORNET","pw"\r\n'));
});

test("a URC interleaved mid-response is queued, not taken as a reply line", () => {
    const s = scenarios.urcInterleaved(rig());
    assert.equal(s.gmr.code, "OK");
    assert.deepEqual(s.gmr.lines, GMR_ESP32C3.slice(0, 4));
    assert.deepEqual(s.state.urcs, ["WIFI DISCONNECT", "0,CLOSED", "WIFI CONNECTED", "WIFI GOT IP"]);
    assert.equal(s.state.wifiGotIp, true);
    assert.equal(s.state.linkOpen, false);
});

test("busy p...: bounded retry; the busy command's late OK is not ours", () => {
    const k = rig();
    const s = scenarios.busyRetry(k);
    assert.equal(s.st.code, "OK");
    assert.deepEqual(s.st.lines, ['+CWSTATE:2,"Werkstatt-WLAN"']);
    assert.ok(s.sends >= 2, `re-sent after busy (sends=${s.sends})`);
    assert.ok(s.stale >= 1, "the late OK of the busy command was dropped as stale");
    assert.ok(s.state.urcs.every((u) => u === "busy p..."));
    assert.equal(s.state.urcs.length, s.sends - 1);
});

test("busy p... forever: gives up with BUSY after busyRetries", () => {
    const k = rig();
    k.at.command("ATE0", 500);
    k.at.busyRetries = 3;
    k.fake.busyUntil = k.clock.t + 1e9;
    const r = k.at.command("AT+CWSTATE?", 1000);
    assert.equal(r.code, "BUSY");
    assert.equal(k.fake.log.filter((l) => l === "AT+CWSTATE?").length, 4);
});

test("a timed-out command's late reply does not leak into the next command", () => {
    const s = scenarios.staleAfterTimeout(rig());
    assert.equal(s.slow.code, "TIMEOUT");
    assert.equal(s.next.code, "OK");
    assert.deepEqual(s.next.lines, ['+CWSTATE:2,"Werkstatt-WLAN"']);
    assert.equal(s.slow2.code, "TIMEOUT");
    assert.equal(s.next2.code, "OK");
    assert.deepEqual(s.next2.lines, ['+CWSTATE:2,"Werkstatt-WLAN"']);
    assert.ok(s.stale >= 2);
});

test("CIPSEND: OK and > in separate chunks; data is written only after >", () => {
    const k = rig({ promptGap: 40 });
    const s = scenarios.cipsendActive(k);
    assert.equal(s.start.code, "OK");
    assert.equal(s.linkAfterStart, true);
    assert.equal(s.send.code, "OK");
    assert.equal(s.send.sent, true);
    assert.deepEqual(s.send.lines, ["Recv 283 bytes"]);
    assert.ok(s.reqIntact);
    assert.deepEqual(s.violations, []);
});

test("a late SEND OK does not end a plain command", () => {
    const k = rig();
    k.at.command("ATE0", 500);
    k.fake.on("AT+CWSTATE?", (l, m, f) => f.reply([[2, "SEND OK\r\n"], [20, '+CWSTATE:2,"x"\r\n\r\nOK\r\n']]));
    const r = k.at.command("AT+CWSTATE?", 1000);
    assert.equal(r.code, "OK");
    assert.deepEqual(r.lines, ['+CWSTATE:2,"x"']);
    assert.equal(k.at.staleFinals, 1);
});

test("busy after the prompt never re-sends the command into data mode", () => {
    const k = rig();
    k.at.command("ATE0", 500);
    k.fake.on("AT+CIPSEND=5", (l, m, f) => f.prompt(5, () =>
        f.reply([[2, "busy s...\r\n"], [300, "Recv 5 bytes\r\n\r\nSEND OK\r\n"]])));
    const r = k.at.sendWithPrompt("AT+CIPSEND=5", "hello", 2000);
    assert.equal(r.code, "OK");
    assert.equal(k.fake.log.filter((l) => l === "AT+CIPSEND=5").length, 1);
    assert.deepEqual(k.fake.received, ["hello"]);
    assert.equal(k.at.busyCount, 1);
});

test("CIPSEND: if the module answers ERROR instead of >, nothing is written", () => {
    const k = rig();
    k.at.command("ATE0", 500);
    k.fake.on("AT+CIPSEND=5", (l, m, f) => f.reply(["link is not valid\r\n\r\nERROR\r\n"]));
    const before = k.fake.written.length;
    const r = k.at.sendWithPrompt("AT+CIPSEND=5", "hello", 1000);
    assert.equal(r.code, "ERROR");
    assert.equal(r.sent, false);
    assert.deepEqual(r.lines, ["link is not valid"]);
    assert.equal(k.fake.written.slice(before), "AT+CIPSEND=5\r\n");
});

test("active +IPD of 1223 bytes with CRLF / OK / ERROR inside arrives intact", () => {
    const k = rig();
    const s = scenarios.cipsendActive(k);
    assert.equal(k.fake.response.length, 1223);
    assert.ok(s.gotAll);
    assert.equal(s.data.length, 1223);
    assert.ok(s.dataIntact);
    // Poison inside the payload must not have produced URCs or state changes.
    assert.deepEqual(s.state.urcs, ["CONNECT", "CLOSED"]);
    assert.equal(s.state.linkOpen, false);
    assert.equal(s.state.resets, 0);
    assert.equal(s.state.wifiConnected, false);
});

test("passive: +IPD,464 notification, then four CIPRECVDATA bites", () => {
    const s = scenarios.cipsendPassive(rig({ recvMode: 0 }), 128);
    assert.equal(s.mode.code, "OK");
    assert.equal(s.send.code, "OK");
    assert.equal(s.pendingAfterNotify, 464);
    assert.deepEqual(s.bites.map((b) => b.len), [128, 128, 128, 80]);
    assert.ok(s.bites.every((b) => b.code === "OK" && b.lines.length === 0));
    assert.ok(s.bodyIntact);
    assert.equal(s.recvBuffered, 0, "passive data never lands in the active receive buffer");
    // The module re-announces the remaining total after every partial pull
    // (measured on ESP-AT 3.3.0.0). passivePending must follow it to 0, not
    // add the announcements up (it once ended at 322 on real hardware).
    assert.deepEqual(s.state.urcs, ["CONNECT", "+IPD,464", "+IPD,336", "+IPD,208", "+IPD,80", "CLOSED"]);
    assert.equal(s.state.passivePending, 0);
});

test("passive: 200-byte bites as measured (200, 200, 64)", () => {
    const s = scenarios.cipsendPassive(rig(), 200);
    assert.deepEqual(s.bites.map((b) => b.len), [200, 200, 64]);
    assert.ok(s.bodyIntact);
});

test("HTTPCPOST: +HTTPCPOST:<len>,<body> before SEND OK is collected as payload", () => {
    const s = scenarios.httpcpost(rig({ promptGap: 15 }));
    assert.equal(s.post.code, "OK");
    assert.equal(s.post.sent, true);
    assert.equal(s.post.payload.length, 227);
    assert.ok(s.post.payload.startsWith('{"cur":6131,"n":1,"ok":1,'));
    assert.ok(s.post.payload.includes("\r\nSEND OK\r\n"));
    assert.deepEqual(s.post.lines, []);
    assert.ok(s.bodyIntact);
    assert.deepEqual(s.violations, []);
});

test("HTTPCLIENT: length-framed body (51 bytes incl. the server's newline)", () => {
    const s = scenarios.httpclient(rig());
    assert.equal(s.get.code, "OK");
    assert.equal(s.get.payload, HEALTH_BODY);
    assert.equal(s.get.payload.length, 51);
    assert.deepEqual(s.get.lines, []);
});

test("GMR: ESP32-C3 / ESP-AT 3.3 via detect()", () => {
    const s = scenarios.gmrDetect(rig());
    assert.deepEqual(s, {
        family: W.FAMILY_ESP32, version: "3.3.0.0", major: 3, minor: 3, chip: "ESP32C3", bin: "v3.3.0.0(MINI-1)",
        httpClient: true, passiveRecv: true, tls: true, sysstore: true,
    });
});

test("GMR: ESP8266 / AT 1.7.4 and the conservative fallbacks", () => {
    const c = W.parseGmr(GMR_ESP8266_AT1.slice(0, 4));
    assert.equal(c.family, W.FAMILY_ESP8266);
    assert.equal(c.version, "1.7.4.0");
    assert.equal(c.major, 1);
    assert.equal(c.minor, 7);
    assert.equal(c.chip, "");
    assert.equal(c.bin, "1.7.4");
    assert.deepEqual([c.httpClient, c.passiveRecv, c.tls, c.sysstore], [false, false, false, false]);

    const u = W.parseGmr([]);
    assert.equal(u.family, W.FAMILY_UNKNOWN);
    assert.deepEqual([u.httpClient, u.passiveRecv, u.tls, u.sysstore], [false, false, false, false]);

    const e8266at2 = W.parseGmr(["AT version:2.2.0.0(s-b097cdf - ESP8266 - Jun 17 2021 12:57:45)"]);
    assert.equal(e8266at2.family, W.FAMILY_ESP32);
    assert.equal(e8266at2.chip, "ESP8266");
    assert.equal(e8266at2.tls, false);
    assert.equal(e8266at2.httpClient, true);

    const at20 = W.parseGmr(["AT version:2.0.0.0(4ecd5b1 - ESP32 - Jan  1 2020 00:00:00)"]);
    assert.equal(at20.httpClient, false);
    assert.equal(at20.passiveRecv, true);
});

test("ready during a transaction ends it and resets the state", () => {
    const k = rig();
    k.at.command("ATE0", 500);
    k.at.command('AT+CWJAP="a","b"', 5000);
    k.fake.on("AT+CWSTATE?", (l, m, f) => { f.echo = true; f.reply([[50, "\r\nready\r\n"]]); });
    const r = k.at.command("AT+CWSTATE?", 2000);
    assert.equal(r.code, "ERROR");
    assert.equal(r.reset, true);
    assert.equal(k.at.resets, 1);
    assert.equal(k.at.echoOn, true);
    assert.equal(k.at.wifiGotIp, false);
});

test("lock: a second caller during a transaction gets BUSY and writes nothing", () => {
    const k = rig();
    k.at.command("ATE0", 500);
    let second = null;
    let writtenBefore = 0;
    k.clock.at(k.clock.t + 200, () => {
        writtenBefore = k.fake.written.length;
        second = k.at.command("AT", 50);
    });
    const r = k.at.command('AT+CWJAP="x","y"', 5000);
    assert.equal(r.code, "OK");
    assert.equal(second.code, "BUSY");
    assert.ok(!k.fake.log.includes("AT"), "the second command was never sent");
    assert.ok(writtenBefore > 0);
});

test("URC queue is bounded; state is updated even when entries are dropped", () => {
    const k = rig();
    let s = "";
    for (let i = 0; i < 20; i++) s += "WIFI CONNECTED\r\nWIFI DISCONNECT\r\n";
    k.at.feed(s + "WIFI CONNECTED\r\nWIFI GOT IP\r\n");
    assert.equal(k.at.urcCount(), 16);
    assert.equal(k.at.lost, 26);
    assert.equal(k.at.wifiGotIp, true);
});

test("parser: frames split byte by byte, zero-length frames, runaway lines", () => {
    const k = rig();
    const stream = "+IPD,0:" + "+IPD,5:a\r\nb>" + "\r\n+IPD,2,3:xyz" + // <id>,<len> (CIPMUX=1)
        // a reply frame nobody waits for (AT 1.x separator order): dropped whole
        "\r\n+CIPRECVDATA,4:q\r\nq\r\n" +
        "+HTTPCLIENT:x\r\n"; // not a header: a plain (dropped) info line
    for (const ch of stream) k.at.feed(ch);
    assert.equal(k.at.recvTake(-1), "a\r\nb>xyz");
    assert.equal(k.at.lost, 4);
    k.at.feed("x".repeat(600));
    k.at.feed("y".repeat(600) + "\r\nCLOSED\r\n");
    assert.deepEqual(state(k.at).urcs, ["CLOSED"]);
});

test("bounds: an oversized frame is dropped whole, never with a hole", () => {
    const k = rig();
    k.at.maxRecv = 8;
    k.at.feed("+IPD,5:abcde");
    k.at.feed("+IPD,5:fghij"); // would exceed 8: dropped whole
    k.at.feed("+IPD,3:klm");
    assert.equal(k.at.recvTake(-1), "abcdeklm");
    assert.equal(k.at.lost, 5);

    const q = rig();
    q.at.command("ATE0", 500);
    q.at.maxPayload = 40;
    const r = q.at.command('AT+HTTPCLIENT=2,0,"https://campus-api.calliope.cc/api/health",,,2', 5000);
    assert.equal(r.code, "OK");
    assert.equal(r.payload, "");
    assert.equal(r.truncated, true);
});

test("recvTake(max) hands out socket data in pieces", () => {
    const k = rig();
    k.at.feed("+IPD,10:0123456789");
    k.at.feed("+IPD,5:abcde");
    assert.equal(k.at.recvTake(4), "0123");
    assert.equal(k.at.recvTake(8), "456789ab");
    assert.equal(k.at.recvAvailable(), 3);
    assert.equal(k.at.recvTake(-1), "cde");
    assert.equal(k.at.recvTake(5), "");
});

test("UART timing: 1 ms pumping keeps up with 1223 bytes at 115200; 100 ms overflows", () => {
    const good = rig({ baud: 115200 });
    const s = scenarios.cipsendActive(good);
    assert.equal(good.fake.overflow, 0);
    assert.ok(s.dataIntact);

    const slow = rig({ baud: 115200 });
    slow.at.command("ATE0", 500);
    slow.at.command(CIPSTART, 5000);
    slow.at.sendWithPrompt("AT+CIPSEND=283", httpRequest(283), 5000);
    slow.at.pollMs = 100; // what the old drivers did
    slow.at.waitRecv(1223, 3000);
    assert.ok(slow.fake.overflow > 0, "the fake's RX buffer model must overflow");
    assert.notEqual(slow.at.recvTake(-1), slow.fake.response);
});

test("SerialPort is the only serial user and resizes the RX buffer to 254", () => {
    const shims = makeShims();
    const X = loadExtension(undefined, shims);
    const p = new X.SerialPort(117, 116, 115200);
    assert.equal(p.read(), "");
    p.write("AT\r\n"); // not open yet: dropped
    p.open();
    p.open();
    shims.serial.feedRx("OK\r\n");
    assert.equal(p.read(), "OK\r\n");
    p.write("AT\r\n");
    assert.deepEqual(shims.serial.log, [
        ["redirect", 117, 116, 115200],
        ["setRxBufferSize", 254],
        ["writeString", "AT\r\n"],
    ]);
});

test("property: random output splits give identical results", () => {
    const runs = [
        ["basicCodes", {}],
        ["echoErrorSsid", {}],
        ["urcInterleaved", {}],
        ["busyRetry", {}],
        ["staleAfterTimeout", {}],
        ["cipsendActive", { promptGap: 40 }],
        ["cipsendPassive", {}],
        ["httpcpost", {}],
        ["httpclient", {}],
        ["gmrDetect", {}],
    ];
    const SEEDS = 60;
    for (const [name, opts] of runs) {
        const baseline = scenarios[name](rig(opts));
        for (let seed = 1; seed <= SEEDS; seed++) {
            const got = scenarios[name](rig({ ...opts, split: rng(seed * 7919 + name.length) }));
            assert.deepEqual(got, baseline, `${name} differs with split seed ${seed}`);
        }
    }
});
