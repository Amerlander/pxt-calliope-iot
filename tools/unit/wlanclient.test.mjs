// Unit tests for the WLAN client (wlanclient.ts, namespace iotwifi).
// Run: npm test   (in tools/unit)
//
// The client runs on the TS reference engine + FakeEsp behind a facade with
// the C++ shim API (fakewlan.mjs); the network, the access point and the
// ingest server are modelled in fakenet.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { wifiRig, plain } from "./fakewlan.mjs";
import { wire } from "./fakenet.mjs";

const OFF = 0, WAKING = 1, JOINING = 2, ONLINE = 3, LOST = 4;
const HTTPCPOST = (n) => `AT+HTTPCPOST="http://192.168.1.172:8090/api/iot/v1/ingest",${n},1,"Content-Type: application/json"`;
const PROD = "https://campus-api.calliope.cc/api/iot/v1";

/** Latin-1 byte string the way pxt stores a source literal (utf8=false). */
const latin1 = (s) => s; // JS chars <= 0xFF are exactly those bytes

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

test("jsonQuote: ASCII, escapes, Latin-1 literals, UTF-8 bytes, invalid sequences", () => {
    const { wifi } = wifiRig();
    assert.equal(wifi.jsonQuote("temp"), '"temp"');
    assert.equal(wifi.jsonQuote(""), '""');
    assert.equal(wifi.jsonQuote('a"b\\c\nd\re\tf\x01'), '"a\\"b\\\\c\\nd\\re\\tf\\u0001"');
    // a pxt literal "für" is f, 0xFC, r (one byte per char)
    assert.equal(wifi.jsonQuote(latin1("f\xfcr Gr\xfc\xdfe")), '"f\\u00fcr Gr\\u00fc\\u00dfe"');
    // the same text as UTF-8 bytes (serial input, server text)
    assert.equal(wifi.jsonQuote(wire("für Grüße")), '"f\\u00fcr Gr\\u00fc\\u00dfe"');
    assert.equal(wifi.jsonQuote(wire("5 €")), '"5 \\u20ac"');
    assert.equal(wifi.jsonQuote(wire("😀")), '"\\ud83d\\ude00"');
    // not UTF-8: a lead byte without continuation, at the end, overlong, surrogate
    assert.equal(wifi.jsonQuote("\xc3A"), '"\\u00c3A"');
    assert.equal(wifi.jsonQuote("x\xc3"), '"x\\u00c3"');
    assert.equal(wifi.jsonQuote("\xc0\xaf"), '"\\u00c0\\u00af"');
    assert.equal(wifi.jsonQuote("\xed\xa0\x80"), '"\\u00ed\\u00a0\\u0080"');
    // simulator strings may hold chars > 0xFF directly
    assert.equal(wifi.jsonQuote("€"), '"\\u20ac"');
    // output is pure ASCII, so Content-Length = characters = bytes
    assert.ok(/^[\x20-\x7e]*$/.test(wifi.jsonQuote(latin1("\xe4\xf6\xfc") + wire("€\u0001"))));
});

test("toUtf8 and atEscape for the CWJAP parameters", () => {
    const { wifi } = wifiRig();
    assert.equal(wifi.toUtf8("plain"), "plain");
    assert.equal(wifi.toUtf8(latin1("Caf\xe9")), wire("Café"));
    assert.equal(wifi.toUtf8(wire("Café")), wire("Café"), "valid UTF-8 stays as it is");
    assert.equal(wifi.atEscape("plain"), "plain");
    assert.equal(wifi.atEscape('a"b,c\\d'), 'a\\"b\\,c\\\\d');
    assert.equal(wifi.atEscape('"'), '\\"');
    assert.equal(wifi.atEscape(",,"), "\\,\\,");
});

// ---------------------------------------------------------------------------
// JSON reader
// ---------------------------------------------------------------------------

function parse(text) {
    const k = wifiRig();
    const a = new k.core.Answer();
    const shape = k.wifi.parseAnswer(text, a);
    return { shape, a: plain(a) };
}

test("reader: the server's answer (keys in Go's alphabetical order)", () => {
    const { shape, a } = parse('{"cur":7612,"n":1,"ok":1,"rej":0,"ts":1760000123,"tzo":120,"w":[{"f":"licht","from":"0","to":"","v":1},{"f":"text","from":"2656000046","to":"0","v":"hi"}]}\n');
    assert.equal(shape, 0);
    assert.deepEqual(a, {
        ok: true, dup: false, error: "", retryAfterMs: 0, serverSec: 1760000123, tzoMin: 120, cur: 7612, more: false,
        dFeeds: ["licht", "text"], dValues: ["1", '"hi"'], dFroms: ["0", "2656000046"], dTos: ["", "0"],
    });
});

test("reader: any key order, nested unknown keys, null/true/false, numbers", () => {
    const { shape, a } = parse(
        ' { "w" : [ { "v" : -1.5e2 , "x":{"a":[1,{"b":"]}"}]}, "to":"", "f":"a", "from":0 } ] ,' +
        ' "extra":[[],{}], "detail":"x]}", "more":true, "dup":1, "ok":true, "cur":null, "tzo":-60, "ts":17 } ');
    assert.equal(shape, 0);
    assert.equal(a.ok, true);
    assert.equal(a.dup, true);
    assert.equal(a.more, true);
    assert.equal(a.cur, -1, "null cursor = none");
    assert.equal(a.tzoMin, -60);
    assert.equal(a.serverSec, 17);
    assert.deepEqual([a.dFeeds, a.dValues, a.dFroms, a.dTos], [["a"], ["-1.5e2"], ["0"], [""]]);
});

test("reader: strings with ] } , \\\" \\\\ \\n \\u escapes and raw UTF-8", () => {
    const { shape, a } = parse(wire(
        '{"ok":1,"w":[{"f":"gr\\u00fc\\u00dfe","v":"a]b}c,d\\"e\\\\f\\ng\\/h","from":"0","to":""},' +
        '{"f":"grüße","v":"ä€😀","from":"0","to":""},{"f":"x","v":null,"from":null,"to":""}]}'));
    assert.equal(shape, 0);
    // keys decode to the literal form: code points <= 0xFF as one byte
    assert.deepEqual(a.dFeeds, ["gr\xfc\xdfe", "gr\xfc\xdfe", "x"]);
    // values stay JSON literals, re-encoded as pure ASCII
    assert.deepEqual(a.dValues, ['"a]b}c,d\\"e\\\\f\\ng\\/h"', '"\\u00e4\\u20ac\\ud83d\\ude00"', "null"]);
    assert.deepEqual(a.dFroms, ["0", "0", ""]);
});

test("reader: error answers, PocketBase errors, cut-off and garbage", () => {
    let r = parse('{"error":"too_fast","ok":0,"retry_after":1}\n');
    assert.deepEqual([r.shape, r.a.ok, r.a.error, r.a.retryAfterMs], [0, false, "too_fast", 1000]);
    r = parse('{"error":"bad_token","ok":0}');
    assert.deepEqual([r.a.ok, r.a.error], [false, "bad_token"]);
    r = parse('{"cur":5,"n":1,"ok":1,"rej":0,"ts":1,"tzo":120,"w":[{"f":"a","from":"0","to":"","v":1},{"f":"b","fr');
    assert.equal(r.shape, 1, "cut off");
    assert.equal(r.a.ok, true);
    r = parse('{"ok":1,"cur":12');
    assert.equal(r.shape, 1, "a number running into the end is cut, not complete");
    assert.equal(parse("<html>502</html>").shape, -1);
    assert.equal(parse("").shape, -1);
    assert.equal(parse('{"ok":1 "cur":2}').shape, 1);
});

// ---------------------------------------------------------------------------
// Bring-up and join
// ---------------------------------------------------------------------------

test("bring-up ESP32-C3 / ESP-AT 3.3: commands in order, UART only after 5 s", () => {
    const k = wifiRig();
    assert.equal(k.wifi.state(), OFF);
    k.connect();
    assert.equal(k.wifi.state(), WAKING, "connect() returns at once");
    assert.equal(k.cmds.length, 0);
    assert.ok(k.core.wlanSender() !== null, "sender registered before any UART is opened");
    assert.equal(k.wifi.waitOnline(60000), true);
    assert.ok(k.cmds[0].t >= 5000, `first command at ${k.cmds[0].t} ms`);
    assert.deepEqual(k.lines(), [
        "AT", "ATE0", "AT+GMR", "AT+SYSSTORE=0", "AT+CWMODE=1", "AT+CIPCLOSE", "AT+CIPMUX=0", "AT+CIPMODE=0",
        "AT+CIPDINFO=0", "AT+SYSLOG=1", "AT+SLEEP=1", "AT+CIPRECVMODE=1", "AT+CWSTATE?", 'AT+CWJAP="Klasse 4b","geheim"', "AT+CWJAP?",
    ]);
    assert.equal(k.wifi.recoveryRung(), "", "a module that answers needs no recovery");
    assert.equal(k.wifi.recoveryRuns(), 0);
    assert.equal(k.wlan.raws.length, 0);
    assert.equal(k.wifi.isOnline(), true);
    assert.equal(k.wifi.stateText(), "online");
    assert.equal(k.wifi.moduleFamily(), 2);
    assert.equal(k.wifi.moduleVersion(), "3.3.0.0");
    assert.equal(k.wifi.moduleChip(), "ESP32C3");
    assert.equal(k.wifi.capabilities(), 15);
    assert.equal(k.wifi.passiveReceive(), true);
    assert.equal(k.wifi.rssi(), -58);
    assert.equal(k.wifi.lastError(), "");
    assert.equal(k.wlan.beginCalls, 1);
});

test("bring-up AT 1.x (ESP8285): _CUR commands, no SYSSTORE/CWSTATE, join ends with FAIL", () => {
    const k = wifiRig({ family: "at1", pw: "richtig" });
    k.connect("Klasse 4b", "falsch");
    k.run(12000);
    assert.deepEqual(k.lines().slice(0, 11), [
        "AT", "ATE0", "AT+GMR", "AT+CWMODE_CUR=1", "AT+CIPCLOSE", "AT+CIPMUX=0", "AT+CIPMODE=0", "AT+CIPDINFO=0",
        "AT+CIPRECVMODE=1", "AT+CWJAP_CUR?", 'AT+CWJAP_CUR="Klasse 4b","falsch"',
    ]);
    assert.equal(k.wifi.lastError(), "wrong-password");
    assert.equal(k.wifi.state(), JOINING);
    assert.equal(k.wifi.moduleFamily(), 1);
    assert.equal(k.wifi.passiveReceive(), false, "AT 1.6/1.7 nano: CIPRECVMODE answers ERROR");
    assert.ok(!k.lines().some((l) => /SYSSTORE|CWSTATE|CWMODE=1|SYSLOG/.test(l)));
    k.connect("Klasse 4b", "richtig");
    assert.equal(k.wifi.waitOnline(30000), true);
    assert.equal(k.wifi.rssi(), -58);
});

test("already on the same SSID: no CWJAP; on another SSID: join", () => {
    const k = wifiRig({ joined: "Klasse 4b" });
    assert.equal(k.online(), true);
    assert.ok(!k.lines().some((l) => l.startsWith("AT+CWJAP=")), "join skipped");
    assert.ok(k.lines().includes("AT+CWSTATE?"));

    const o = wifiRig({ joined: "Nachbar" });
    assert.equal(o.online(), true);
    assert.equal(o.net.joins.length, 1);

    // AT 1.x: CWJAP_CUR? names the AP, CIPSTATUS proves the address
    const a = wifiRig({ family: "at1", joined: "Klasse 4b" });
    assert.equal(a.online(), true);
    assert.ok(a.lines().includes("AT+CIPSTATUS"));
    assert.equal(a.net.joins.length, 0);
});

test("join failure reasons: wrong password, AP not found, timeout", () => {
    const pw = wifiRig();
    pw.connect("Klasse 4b", "falsch");
    pw.run(12000);
    assert.equal(pw.wifi.lastError(), "wrong-password");
    assert.equal(pw.wifi.state(), JOINING);

    const ap = wifiRig();
    ap.net.ap.present = false;
    ap.connect();
    ap.run(10000);
    assert.equal(ap.wifi.lastError(), "ap-not-found");

    const to = wifiRig();
    to.net.ap.outcome = "timeout";
    to.connect();
    to.run(25000);
    assert.equal(to.wifi.lastError(), "join-timeout");
    assert.equal(to.wifi.isOnline(), false);
});

test("SSID and password are escaped for AT; Latin-1 literals go out as UTF-8", () => {
    const k = wifiRig({ ssid: wire('Café "4b", Raum\\1'), pw: "p,w\"x" });
    k.connect(latin1('Caf\xe9 "4b", Raum\\1'), 'p,w"x');
    assert.equal(k.wifi.waitOnline(30000), true);
    const j = k.lines().find((l) => l.startsWith("AT+CWJAP="));
    assert.equal(j, 'AT+CWJAP="Caf' + wire("é") + ' \\"4b\\"\\, Raum\\\\1","p\\,w\\"x"');
});

test("WIFI DISCONNECT -> LOST at once -> rejoin with backoff 1 s .. 30 s", () => {
    const k = wifiRig();
    assert.equal(k.online(), true);
    k.net.ap.present = false;
    const t0 = k.clock.t;
    k.net.dropWifi();
    k.run(250); // the next fiber turn
    assert.equal(k.wifi.state(), LOST);
    assert.equal(k.wifi.lastError(), "wifi-lost");
    assert.equal(k.wifi.isOnline(), false);
    k.run(120000);
    const starts = k.net.joins.slice(1).map((j) => j.t);
    // each attempt: CWSTATE? + CWJAP answering +CWJAP:3 after 3 s, then the backoff
    assert.ok(starts[0] - t0 >= 1000 && starts[0] - t0 < 1300, `first rejoin after ${starts[0] - t0} ms`);
    const waits = starts.slice(1).map((t, i) => t - starts[i] - 3000);
    const want = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (let i = 0; i < want.length && i < waits.length; i++) {
        assert.ok(waits[i] >= want[i] && waits[i] < want[i] + 400, `wait ${i}: ${waits[i]} ms, want ~${want[i]}`);
    }
    assert.ok(waits.length >= 5);
    assert.equal(k.wifi.state(), JOINING);
    assert.equal(k.wifi.lastError(), "ap-not-found");
    k.net.ap.present = true;
    k.run(40000);
    assert.equal(k.wifi.state(), ONLINE);
});

test("the module reconnects by itself: GOT IP -> check at once, no CWJAP", () => {
    const k = wifiRig();
    assert.equal(k.online(), true);
    const joins = k.net.joins.length;
    k.net.dropWifi();
    k.run(250); // the next fiber turn
    assert.equal(k.wifi.state(), LOST);
    k.net.autoReconnect(300);
    k.run(1500);
    assert.equal(k.wifi.state(), ONLINE);
    assert.equal(k.net.joins.length, joins, "CWSTATE? showed the same SSID");
});

test("sleep: radio off, no checks while asleep; a post wakes it (radio on, join) and goes through", () => {
    const k = wifiRig();
    assert.equal(k.online(), true);
    k.wifi.sleep();
    assert.equal(k.wifi.state(), 5, "SLEEPING");
    assert.equal(k.wifi.stateText(), "sleeping");
    assert.equal(k.net.joined, null, "left the network");
    assert.equal(k.net.radioOff, true, "radio off");
    const n = k.cmds.length;
    k.run(70000);
    assert.equal(k.wifi.state(), 5, "stays asleep: the WIFI DISCONNECT is no lost connection");
    assert.equal(k.cmds.length, n, "no link checks while asleep");
    const a = k.post(k.batch(), k.ctx());
    assert.equal(a.ok, true, `post after wake: ${a.error}`);
    assert.equal(k.wifi.state(), ONLINE);
    assert.equal(k.net.radioOff, false);
    const sent = k.lines().slice(n);
    assert.ok(sent.indexOf("AT+CWMODE=1") >= 0 && sent.indexOf("AT+CWMODE=1") < sent.findIndex((l) => l.startsWith("AT+CWJAP=")),
        `radio on before the join: ${sent.join(" | ")}`);
});

test("sleep only from ONLINE; a module reset while asleep brings it up again", () => {
    const k = wifiRig();
    k.connect();
    k.wifi.sleep(); // still OFF/WAKING: nothing to save power on
    assert.notEqual(k.wifi.state(), 5);
    assert.equal(k.wifi.waitOnline(60000), true);
    k.wifi.sleep();
    assert.equal(k.wifi.state(), 5);
    k.net.reboot(50);
    k.run(15000);
    assert.equal(k.wifi.state(), ONLINE, "a reboot re-runs the bring-up and joins");
});

test("a silent loss (no URC) is caught by the 30 s AT+CWJAP? check", () => {
    const k = wifiRig();
    assert.equal(k.online(), true);
    k.net.joined = null; // no WIFI DISCONNECT printed
    k.run(29000);
    assert.equal(k.wifi.state(), ONLINE);
    assert.equal(k.net.joins.length, 1);
    const seen = k.states.length;
    k.run(6000);
    assert.ok(k.states.slice(seen).includes(LOST), `states after the check: ${k.states.slice(seen)}`);
    assert.equal(k.wifi.lastError(), "wifi-lost");
    assert.equal(k.net.joins.length, 2, "rejoined");
    assert.equal(k.wifi.state(), ONLINE);
});

test("module reset (ready) re-runs the bring-up", () => {
    const k = wifiRig();
    assert.equal(k.online(), true);
    const n = k.cmds.length;
    k.net.reboot();
    k.run(500);
    k.run(10000);
    assert.equal(k.wifi.state(), ONLINE);
    const again = k.lines(n);
    assert.deepEqual(again.slice(0, 3), ["AT", "ATE0", "AT+GMR"]);
    assert.ok(again.includes("AT+CIPRECVMODE=1"), "receive mode set again (the reboot reset it)");
    assert.ok(again.some((l) => l.startsWith("AT+CWJAP=")));
    assert.equal(k.wifi.lastError(), "module-reset");
    assert.equal(k.fake.recvMode, 1);
});

test("no module: wake fails, bring-up retries with backoff; begin < 0 is reported", () => {
    const k = wifiRig();
    k.fake.handlers.length = 0; // a module that never answers
    k.connect();
    k.run(30000);
    assert.equal(k.wifi.state(), WAKING);
    assert.equal(k.wifi.lastError(), "no-module");

    const u = wifiRig({ beginResult: -2 });
    u.connect();
    u.run(10000);
    assert.equal(u.wifi.lastError(), "uart-2");
    assert.equal(u.cmds.length, 0);
});

// ---------------------------------------------------------------------------
// Ingest over AT+HTTPCPOST
// ---------------------------------------------------------------------------

test("postIngest before ONLINE: offline, at once, nothing sent", () => {
    const k = wifiRig();
    assert.equal(k.post(k.batch(), k.ctx()).error, "offline");
    k.connect();
    const t = k.clock.t;
    const a = k.post(k.batch(), k.ctx());
    assert.deepEqual([a.ok, a.error, k.clock.t - t, k.cmds.length], [false, "offline", 0, 0]);
});

test("HTTPCPOST: request body, answer, downlink in the literal form", () => {
    const k = wifiRig();
    k.net.server.write("0", "grüße", "ä€");
    k.net.server.write("0", "soll", 21.5);
    assert.equal(k.online(), true);
    const b = k.batch(7, 2);
    b.feeds[0] = latin1("gr\xf6\xdfe");
    b.values[1] = k.wifi.jsonQuote(latin1("Gr\xfc\xdfe"));
    b.labelKeys = [latin1("gr\xf6\xdfe")];
    b.labelTexts = [latin1("Gr\xf6\xdfe")];
    const c = k.ctx();
    const n = k.cmds.length;
    const a = k.post(b, c);
    assert.deepEqual(plain(a), {
        ok: true, dup: false, error: "", retryAfterMs: 0, serverSec: a.serverSec, tzoMin: 120, cur: 104, more: false,
        dFeeds: ["gr\xfc\xdfe", "soll"], dValues: ['"\\u00e4\\u20ac"', "21.5"], dFroms: ["0", "0"], dTos: ["", ""],
    });
    assert.ok(a.serverSec > 1760000000);
    const sent = k.net.posts[0].body;
    assert.deepEqual(k.lines(n), [HTTPCPOST(sent.length)]);
    assert.ok(/^[\x20-\x7e]*$/.test(sent), "the body is pure ASCII");
    const req = k.net.server.requests[0];
    assert.deepEqual(Object.keys(req), ["t", "dev", "now", "boot", "s", "scope", "since", "n", "d"]);
    assert.deepEqual(req.n, { "größe": "Größe" });
    assert.deepEqual(req.d, [
        { f: "größe", v: 21.5, dt: -2000, to: "" },
        { f: "text1", v: "Grüße", dt: -1000, to: "0" },
    ]);
    assert.deepEqual([req.t, req.dev, req.boot, req.s, req.scope, req.since], ["W-TEST-TEST-TEST", "2656000046", "b0123", 7, "a", 0]);
    assert.equal(req.now, k.net.posts[0].t > 0 ? req.now : -1);
    // the batch was not touched
    assert.deepEqual(b.ages, [2000, 1000]);
    assert.equal(b.values[1], '"Gr\\u00fc\\u00dfe"');
});

test("HTTPCPOST: second post with the cursor; 429 too_fast; retry -> ok; replay -> dup", () => {
    const k = wifiRig({ latency: 100 });
    assert.equal(k.online(), true);
    const a1 = k.post(k.batch(1), k.ctx());
    assert.equal(a1.ok, true);
    k.net.server.write("0", "soll", 3);
    k.run(1200);
    const a2 = k.post(k.batch(2), k.ctx(undefined, a1.cur));
    assert.deepEqual([a2.ok, a2.dFeeds, a2.cur], [true, ["soll"], a1.cur + 3]);
    const a3 = k.post(k.batch(3), k.ctx(undefined, a2.cur));
    assert.deepEqual([a3.ok, a3.error, a3.retryAfterMs], [false, "too_fast", 1000]);
    assert.deepEqual([a3.cur, a3.dFeeds.length], [-1, 0]);
    k.run(a3.retryAfterMs);
    const a4 = k.post(k.batch(3), k.ctx(undefined, a2.cur));
    assert.deepEqual([a4.ok, a4.dup], [true, false]);
    k.run(1000);
    const a5 = k.post(k.batch(3), k.ctx(undefined, a2.cur));
    assert.deepEqual([a5.ok, a5.dup], [true, true]);
});

test("HTTPCPOST on 4xx: every way the module might report it", () => {
    const cases = [
        ["body-fail", "bad_token"],
        ["body-ok", "bad_token"],
        ["errcode", "http-401"],
        ["nobody-fail", "send"],
    ];
    for (const [mode, want] of cases) {
        const k = wifiRig({ httpcMode: mode });
        assert.equal(k.online(), true);
        const c = k.ctx();
        c.ref = "W-NOPE-NOPE-NOPE";
        const a = k.post(k.batch(), c);
        assert.deepEqual([a.ok, a.error], [false, want], mode);
        assert.equal(k.wifi.state(), ONLINE, "a server error does not touch the WiFi state");
    }
    const z = wifiRig({ httpcMode: "errcode", latency: 100 });
    assert.equal(z.online(), true);
    z.post(z.batch(1), z.ctx());
    assert.equal(z.post(z.batch(2), z.ctx()).error, "http-429");
});

test("HTTPCPOST answer larger than the engine's buffer: ok kept, rows dropped, next request over TCP", () => {
    const k = wifiRig();
    for (let i = 0; i < 20; i++) k.net.server.write("0", "feed" + i, "x".repeat(120));
    assert.equal(k.online(), true);
    const a = k.post(k.batch(1), k.ctx());
    assert.deepEqual([a.ok, a.error, a.cur, a.more, a.dFeeds.length], [true, "", -1, true, 0]);
    k.run(1200);
    const n = k.cmds.length;
    const b = k.post(k.batch(2), k.ctx());
    assert.ok(k.lines(n)[0].startsWith("AT+CIPSTART=\"TCP\""), "TCP has no 2 KB bound");
    assert.deepEqual([b.ok, b.dFeeds.length, b.cur], [true, 20, 124]);
});

test("reset or WiFi loss during a post", () => {
    const k = wifiRig();
    assert.equal(k.online(), true);
    k.fake.on(/^AT\+HTTPCPOST=/, () => k.net.reboot(50));
    const a = k.post(k.batch(), k.ctx());
    assert.deepEqual([a.ok, a.error], [false, "reset"]);
    assert.equal(k.wifi.state(), WAKING);
    k.fake.handlers.pop();
    k.run(10000);
    assert.equal(k.wifi.state(), ONLINE);

    const w = wifiRig();
    assert.equal(w.online(), true);
    w.fake.on(/^AT\+HTTPCPOST="[^"]+",(\d+)/, (l, m, f) => f.prompt(+m[1], () => {
        w.net.dropWifi();
        f.reply([[300, "SEND FAIL\r\n"]]);
    }));
    const b = w.post(w.batch(), w.ctx());
    assert.deepEqual([b.ok, b.error], [false, "wifi"]);
    assert.equal(w.wifi.state(), LOST);
});

test("the fiber and postIngest never interleave: a post during the fiber's check gets busy", () => {
    const k = wifiRig();
    assert.equal(k.online(), true);
    let during = null;
    let linesBefore = 0;
    k.fake.on("AT+CWJAP?", (l, m, f) => {
        linesBefore = k.cmds.length;
        k.clock.at(k.clock.t + 1, () => { during = k.post(k.batch(), k.ctx()); });
        f.reply([[2, `+CWJAP:"Klasse 4b","5c:49:79:2a:10:01",6,-61,0,1,3,0,1\r\n\r\nOK\r\n`]]);
    });
    k.run(31000);
    assert.ok(during, "the post ran while the check held the lock");
    assert.deepEqual([during.ok, during.error], [false, "busy"]);
    assert.ok(!k.lines(linesBefore).some((l) => l.startsWith("AT+HTTPCPOST")), "nothing was sent in between");
    assert.equal(k.wifi.rssi(), -61);
    assert.equal(k.post(k.batch(), k.ctx()).ok, true);
});

// ---------------------------------------------------------------------------
// Ingest over CIPSTART / CIPSEND
// ---------------------------------------------------------------------------

test("TCP passive: CIPRECVDATA pulls follow the re-announced remaining total", () => {
    const k = wifiRig();
    for (let i = 0; i < 6; i++) k.net.server.write("0", "feed" + i, i * 1.5);
    assert.equal(k.online(), true);
    k.wifi.preferTcp(true);
    const n = k.cmds.length;
    const a = k.post(k.batch(1), k.ctx());
    assert.equal(a.ok, true);
    assert.deepEqual(a.dFeeds, ["feed0", "feed1", "feed2", "feed3", "feed4", "feed5"]);
    assert.equal(a.cur, 108);
    const sent = k.net.sends[0].data;
    assert.ok(sent.startsWith("POST /api/iot/v1/ingest HTTP/1.1\r\nHost: 192.168.1.172:8090\r\nContent-Type: application/json\r\nContent-Length: "));
    assert.ok(sent.includes("\r\nConnection: close\r\n\r\n{\"t\":"));
    const lines = k.lines(n);
    assert.equal(lines[0], 'AT+CIPSTART="TCP","192.168.1.172",8090');
    assert.equal(lines[1], `AT+CIPSEND=${sent.length}`);
    const total = k.net.responses[0].length;
    const pulls = lines.filter((l) => l === "AT+CIPRECVDATA=200").length;
    assert.ok(total > 400, `response ${total} bytes`);
    assert.equal(pulls, Math.ceil(total / 200), "one pull per 200 bytes, none extra");
    assert.ok(!lines.includes("AT+CIPCLOSE"), "the server closed after the last pull");
    assert.equal(k.wlan.stats(0), 0, "passivePending followed the re-announcements down to 0");
});

test("TCP passive, chunked answer without Content-Length: ends with CLOSED", () => {
    const k = wifiRig({ chunked: true });
    k.net.server.write("0", "a", 1);
    assert.equal(k.online(), true);
    k.wifi.preferTcp(true);
    const a = k.post(k.batch(1), k.ctx());
    assert.deepEqual([a.ok, a.dFeeds, a.cur], [true, ["a"], 103]);
});

test("TCP active (AT 1.x): +IPD frames, 429 from the status line, too-big at 2048", () => {
    const k = wifiRig({ family: "at1", segment: 100, minInterval: 900 });
    for (let i = 0; i < 4; i++) k.net.server.write("0", "f" + i, "v" + i);
    assert.equal(k.online(), true);
    const n = k.cmds.length;
    const a = k.post(k.batch(1), k.ctx());
    assert.deepEqual([a.ok, a.dFeeds.length, a.cur], [true, 4, 106]);
    assert.ok(!k.lines(n).some((l) => l.startsWith("AT+CIPRECVDATA") || l.startsWith("AT+HTTPCPOST")));
    const b = k.post(k.batch(2), k.ctx());
    assert.deepEqual([b.ok, b.error, b.retryAfterMs], [false, "too_fast", 1000]);
    const big = k.batch(3);
    big.values[1] = '"' + "x".repeat(2000) + '"';
    const before = k.cmds.length;
    assert.equal(k.post(big, k.ctx()).error, "too-big");
    assert.equal(k.cmds.length, before, "nothing sent");
});

test("https: no TLS -> tls error without an attempt; TLS without HTTP client -> CIPSTART SSL", () => {
    const k = wifiRig({ family: "at1" });
    assert.equal(k.online(), true);
    const n = k.cmds.length;
    const a = k.post(k.batch(), k.ctx(PROD));
    assert.deepEqual([a.ok, a.error, k.cmds.length], [false, "tls", n]);

    const s = wifiRig({ family: "at20" });
    assert.equal(s.online(), true);
    assert.equal(s.wifi.capabilities(), 2 | 4, "ESP-AT 2.0: passive + TLS, no HTTP client, no SYSSTORE");
    const m = s.cmds.length;
    const c = s.ctx(PROD);
    c.ref = "W-HIL0-TEST-0000";
    const b = s.post(s.batch(), c);
    assert.deepEqual([b.ok, b.error], [false, "bad_token"]);
    assert.deepEqual(s.lines(m).slice(0, 2), [
        'AT+CIPSSLCSNI="campus-api.calliope.cc"', 'AT+CIPSTART="SSL","campus-api.calliope.cc",443',
    ]);
    assert.ok(s.net.sends[0].data.includes("\r\nHost: campus-api.calliope.cc\r\n"));
});

test("too-big on ESP-AT (8192), bad URL, unknown host", () => {
    const k = wifiRig();
    assert.equal(k.online(), true);
    const big = k.batch(1);
    big.values[1] = '"' + "x".repeat(8200) + '"';
    const n = k.cmds.length;
    assert.equal(k.post(big, k.ctx()).error, "too-big");
    assert.equal(k.cmds.length, n);
    assert.equal(k.post(k.batch(), k.ctx("http:///api")).error, "bad-url");
    k.wifi.preferTcp(true);
    assert.equal(k.post(k.batch(), k.ctx("http://nohost.invalid/api/iot/v1")).error, "dns");
});
