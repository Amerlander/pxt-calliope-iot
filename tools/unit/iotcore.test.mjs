// Unit tests for the IoT core (iotcore.ts): send buffer, WLAN batches, timing,
// cursor, handlers, scope, identity, clock, JSON. Run: npm test (in tools/unit)

import { test } from "node:test";
import assert from "node:assert/strict";
import { rig, DEVICE_ID, PARK } from "./iotharness.mjs";

/** Times between consecutive calls. */
const gaps = (calls) => calls.slice(1).map((c, i) => c.t - calls[i].t);

// ---------------------------------------------------------------------------
// send buffer and batches

test("overflow during an in-flight request removes by id, not by position", () => {
    const r = rig();
    const calls = r.wlan(() => r.ok());
    const sent = [];
    r.core.onSent("", (feed, v) => sent.push(v));
    r.core.setSync(5000);
    for (let i = 0; i < 8; i++) r.core.send("f", i);
    r.step(100, { fibersToo: false }); // batch frozen, sender fiber queued: in flight
    assert.equal(calls.length, 0);
    for (let i = 0; i < 24; i++) r.core.send("f", 100 + i); // drops the 8 in-flight points
    assert.equal(r.core.queued(), 24);
    r.runFibers(); // the request completes: ok
    assert.deepEqual(calls[0].values, ["0", "1", "2", "3", "4", "5", "6", "7"]);
    r.step(); // answer processed
    // The 8 confirmed points were already gone; nothing else may be removed.
    assert.equal(r.core.queued(), 24);
    r.runFibers();
    assert.deepEqual(sent, [0, 1, 2, 3, 4, 5, 6, 7], "onSent reports what the server confirmed");
    r.core.sendNow();
    r.run(12000);
    const later = calls.slice(1).flatMap((c) => c.values);
    assert.deepEqual(later.slice(0, 24), Array.from({ length: 24 }, (_, i) => String(100 + i)));
});

test("partial overflow during a request keeps every unsent point", () => {
    const r = rig();
    const calls = r.wlan(() => r.ok());
    r.core.setSync(1000);
    for (let i = 0; i < 8; i++) r.core.send("f", i);
    r.step(100, { fibersToo: false });
    for (let i = 0; i < 20; i++) r.core.send("f", 100 + i); // drops ids 1..4 only
    r.runFibers();
    r.step();
    assert.equal(r.core.queued(), 20, "ids 5..8 removed by id, the 20 new ones stay");
    r.run(4000);
    const later = calls.slice(1).flatMap((c) => c.values);
    assert.deepEqual(later, Array.from({ length: 20 }, (_, i) => String(100 + i)));
});

test("buffer keeps the newest 24 points", () => {
    const r = rig();
    for (let i = 0; i < 30; i++) r.core.send("f", i);
    assert.equal(r.core.queued(), 24);
});

test("a batch holds at most BATCH_MAX points and respects the byte budget", () => {
    const r = rig();
    const calls = r.wlan(() => r.ok());
    r.core.setSync(1000);
    for (let i = 0; i < 12; i++) r.core.send("f", i);
    r.run(2500);
    assert.equal(calls[0].feeds.length, 8);
    assert.equal(calls[1].feeds.length, 4);

    const r2 = rig();
    const calls2 = r2.wlan(() => r2.ok());
    r2.core.setSync(1000);
    const big = "x".repeat(160);
    for (let i = 0; i < 6; i++) r2.core.sendText("t", big);
    r2.run(1500);
    assert.ok(calls2[0].feeds.length < 6, "six 160-byte texts do not fit one 800-byte batch");
    assert.ok(calls2[0].feeds.length >= 1);
});

test("a retry resends the same frozen batch: same seq, same points, same boot", () => {
    const r = rig();
    const calls = r.wlan((c, n) => (n === 1 ? r.fail("wifi") : r.ok()));
    r.core.setSync(5000);
    r.core.send("a", 1);
    r.core.send("b", 2);
    r.step(); // attempt 1 fails
    r.core.send("c", 3); // queued meanwhile: must NOT join the retried batch
    r.run(1500); // back-off 1 s, then attempt 2
    assert.equal(calls.length, 2);
    assert.equal(calls[1].seq, calls[0].seq);
    assert.equal(calls[1].boot, calls[0].boot);
    assert.deepEqual(calls[1].values, calls[0].values);
    assert.deepEqual(calls[1].feeds, ["a", "b"]);
    assert.ok(calls[1].ages[0] > calls[0].ages[0], "ages are recomputed per attempt");
    assert.ok(calls[0].boot.length > 0 && calls[0].boot.length <= 32);
    r.core.sendNow();
    r.run(1500);
    assert.equal(calls[2].seq, calls[0].seq + 1, "a new batch gets the next seq");
    assert.deepEqual(calls[2].feeds, ["c"]);
});

test("boot differs per boot, seq starts at 1", () => {
    const a = rig({ seed: 1 });
    const b = rig({ seed: 2 });
    const ca = a.wlan(() => a.ok());
    const cb = b.wlan(() => b.ok());
    a.core.send("x", 1);
    b.core.send("x", 1);
    a.step();
    b.step();
    assert.equal(ca[0].seq, 1);
    assert.notEqual(ca[0].boot, cb[0].boot);
});

test("points leave and onSent fires only after the server confirmed", () => {
    const r = rig();
    let fails = 2;
    const calls = r.wlan(() => (fails-- > 0 ? r.fail("http-500") : r.ok()));
    const sent = [];
    r.core.onSent("temp", (feed, v, to) => sent.push([feed, v, to]));
    r.core.send("temp", 5, "0");
    r.run(2000);
    assert.equal(sent.length, 0);
    assert.equal(r.core.queued(), 1);
    assert.equal(r.core.status(), r.core.STATE_ERROR);
    assert.equal(r.core.lastError(), "http-500");
    r.run(4000);
    assert.equal(calls.filter((c) => c.feeds.length > 0).length, 3, "two failures, then the confirmed retry");
    assert.deepEqual(sent, [["temp", 5, "0"]]);
    assert.equal(r.core.queued(), 0);
    assert.equal(r.core.status(), r.core.STATE_CONNECTED);
    assert.equal(r.core.lastError(), "");
});

test("dup counts as confirmed", () => {
    const r = rig();
    r.wlan(() => r.ok({ dup: true }));
    let sent = 0;
    r.core.onSent("", () => sent++);
    r.core.send("a", 1);
    r.run(300);
    assert.equal(sent, 1);
    assert.equal(r.core.queued(), 0);
});

test("a null answer counts as a failure", () => {
    const r = rig();
    r.wlan(() => null);
    r.core.send("a", 1);
    r.run(300);
    assert.equal(r.core.status(), r.core.STATE_ERROR);
    assert.equal(r.core.lastError(), "no-answer");
    assert.equal(r.core.queued(), 1);
});

test("labels: the typed spelling goes in the batch until the server confirmed it", () => {
    const r = rig();
    let n = 0;
    const calls = r.wlan(() => (++n === 1 ? r.fail("timeout") : r.ok()));
    r.core.setSync(1000);
    r.core.send("Licht", 1);
    r.core.send("licht", 2);
    r.core.send("temp", 3);
    r.run(3500);
    assert.deepEqual(calls[0].feeds, ["licht", "licht", "temp"]);
    assert.deepEqual(calls[0].labelKeys, ["licht"]);
    assert.deepEqual(calls[0].labelTexts, ["Licht"]);
    assert.deepEqual(calls[1].labelKeys, ["licht"], "the retry still carries it");
    r.core.send("Licht", 4);
    r.run(1500);
    assert.deepEqual(calls[2].labelKeys, [], "once per boot");
});

// ---------------------------------------------------------------------------
// timing

test("WLAN floor: 'immediately' means at most one request per second", () => {
    const r = rig();
    const calls = r.wlan(() => r.ok());
    r.core.setSync(0);
    for (let t = 0; t < 6000; t += 100) {
        r.core.send("f", t);
        r.step();
    }
    assert.ok(calls.length >= 5 && calls.length <= 7, `requests: ${calls.length}`);
    for (const g of gaps(calls)) assert.ok(g >= 1000, `gap ${g}`);
});

test("a full buffer goes early but never under the floor", () => {
    const r = rig();
    const calls = r.wlan(() => r.ok());
    r.core.setSync(3600000);
    r.step(); // first request (clock + snapshot)
    for (let t = 0; t < 5000; t += 100) {
        for (let k = 0; k < 10; k++) r.core.send("f", k);
        r.step();
    }
    assert.ok(calls.length >= 4, `requests: ${calls.length}`);
    for (const g of gaps(calls)) assert.ok(g >= 1000, `gap ${g}`);
});

test("back-off 1 s, 2 s, 4 s … capped at 30 s", () => {
    const r = rig();
    const calls = r.wlan(() => r.fail("wifi"));
    r.core.send("f", 1);
    r.run(130000);
    const g = gaps(calls);
    const want = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (let i = 0; i < want.length; i++) {
        assert.ok(g[i] >= want[i] && g[i] <= want[i] + 200, `gap ${i}: ${g[i]}, want ~${want[i]}`);
    }
});

test("retryAfterMs takes precedence over the own back-off", () => {
    const r = rig();
    let n = 0;
    const calls = r.wlan(() => {
        n++;
        if (n <= 4) return r.fail("wifi"); // back-off grows to 8 s
        if (n === 5) return r.fail("too_fast", { retryAfterMs: 2000 }); // shorter than 16 s
        if (n === 6) return r.fail("too_fast", { retryAfterMs: 20000 }); // longer than the back-off
        return r.ok();
    });
    r.core.send("f", 1);
    r.run(80000);
    const g = gaps(calls);
    assert.ok(g[4] >= 2000 && g[4] <= 2200, `after retry_after 2 s: ${g[4]}`);
    assert.ok(g[5] >= 20000 && g[5] <= 20200, `after retry_after 20 s: ${g[5]}`);
    assert.equal(r.core.queued(), 0);
});

test("back in the network (module plugged in again): the waiting batch goes at once, not after the back-off", () => {
    const r = rig();
    let up = false;
    const calls = r.wlan(() => (up ? r.ok() : r.fail("offline")));
    r.core.send("f", 1);
    r.run(70000); // the back-off has grown to 30 s
    const n = calls.length;
    r.run(2000);
    assert.equal(calls.length, n, "still backing off");
    up = true;
    r.core.wlanCameOnline();
    r.run(300);
    assert.equal(calls.length, n + 1, "resent at the next tick");
    assert.equal(r.core.queued(), 0);
});

test("back in the network does not cut a server's retry_after short", () => {
    const r = rig();
    const calls = r.wlan(() => r.fail("too_fast", { retryAfterMs: 20000 }));
    r.core.send("f", 1);
    r.run(500);
    const n = calls.length;
    r.core.wlanCameOnline();
    r.run(5000);
    assert.equal(calls.length, n, "the server's wait stands");
});

test("too_fast is pacing: no error state, no back-off, the batch goes after retry_after", () => {
    const r = rig();
    let n = 0;
    const sent = [];
    r.core.onSent("", (feed, value, to) => sent.push([feed, value]));
    const calls = r.wlan(() => {
        n++;
        if (n === 2) return r.fail("too_fast", { retryAfterMs: 1000 });
        return r.ok();
    });
    r.core.setSync(1000);
    r.step(); // first request (clock)
    r.core.send("f", 7);
    for (let t = 0; t < 5000 && n < 2; t += 100) r.step(); // second request: 429
    r.step(); // its answer is processed
    assert.equal(n, 2);
    assert.notEqual(r.core.status(), r.core.STATE_ERROR);
    assert.equal(r.core.lastError(), "");
    r.run(2000);
    assert.deepEqual(sent, [["f", 7]]);
    const g = gaps(calls);
    assert.ok(g[g.length - 1] >= 1000 && g[g.length - 1] <= 1300, `resent after ${g[g.length - 1]} ms`);
});

test("NaN or omitted interval keeps the previous one; the loop never goes silent", () => {
    const r = rig();
    const calls = r.wlan(() => r.ok());
    r.core.setSync(3000);
    r.core.setSync(NaN);
    r.core.setSync(undefined);
    r.core.setSync(-5);
    r.step(); // first request (clock)
    for (let t = 0; t < 10000; t += 100) {
        if (t % 500 === 0) r.core.send("f", t);
        r.step();
    }
    const g = gaps(calls).slice(1);
    assert.ok(g.length >= 2, `requests: ${calls.length}`);
    for (const x of g) assert.ok(x >= 2900 && x <= 3200, `gap ${x}, want ~3000`);
});

test("Campus: interval 0 sends every value at the next tick", () => {
    const r = rig();
    r.core.setSync(0);
    r.run(400);
    r.core.send("f", 1);
    r.step();
    assert.ok(r.serialLines().includes("IOT1:d::f:1"));
});

test("an idle WLAN program polls only when it reads something or needs the clock", () => {
    const r = rig();
    const calls = r.wlan(() => r.ok({ serverSec: 1790000000, tzoMin: 120 }));
    r.core.setSync(1000);
    r.run(5000);
    assert.equal(calls.length, 1, "one request for the clock, then silence");
    r.core.onNumber("soll", r.core.WHO_DASHBOARD, () => {});
    r.run(5000);
    // A program that receives asks every sync interval (1 s here).
    assert.ok(calls.length >= 5, `a reading program polls: ${calls.length}`);
});

// ---------------------------------------------------------------------------
// cursor and downlink

test("the cursor advances only after the rows were dispatched, and only on ok", () => {
    const r = rig();
    const got = [];
    r.core.onNumber("soll", r.core.WHO_ALL, (v, from) => got.push([v, from]));
    let n = 0;
    const calls = r.wlan(() => {
        n++;
        if (n === 1) return r.ok({ cur: 42, rows: [["soll", "7", "0", ""], ["soll", "8", "123", ""]] });
        if (n === 2) return r.fail("http-500", { cur: 99, dFeeds: ["soll"], dValues: ["666"], dFroms: ["0"], dTos: [""] });
        return r.ok({ cur: 50 });
    });
    r.core.setSync(1000);
    r.run(200);
    assert.equal(calls[0].since, 0);
    assert.deepEqual(got, [[7, "0"], [8, "123"]]);
    assert.equal(r.core.read("soll", "0"), 7);
    r.run(1200);
    assert.equal(calls[1].since, 42, "next request continues from cur");
    r.run(3000);
    assert.equal(calls[2].since, 42, "a failed answer moves nothing");
    assert.ok(!got.some(([v]) => v === 666), "rows of a failed answer are not dispatched");
    r.run(1200);
    assert.equal(calls[3].since, 50);
});

test("more asks again at the floor instead of a whole interval later", () => {
    const r = rig();
    let n = 0;
    const calls = r.wlan(() => (++n === 1 ? r.ok({ cur: 10, more: true }) : r.ok({ cur: 20 })));
    r.core.onNumber("x", r.core.WHO_DASHBOARD, () => {});
    r.core.setSync(30000);
    r.run(3000);
    assert.equal(calls.length, 2);
    const g = calls[1].t - calls[0].t;
    assert.ok(g >= 1000 && g <= 1200, `follow-up after ${g} ms`);
    assert.equal(calls[1].since, 10);
});

test("server clock: set from the answer, jump only beyond 2 s, time known flag", () => {
    const r = rig();
    let sec = 1790000000;
    r.wlan(() => r.ok({ serverSec: sec, tzoMin: 120 }));
    assert.equal(r.core.timeKnown(), false);
    assert.equal(r.core.unixSeconds(), 0);
    r.core.send("a", 1);
    r.step();
    r.step();
    assert.equal(r.core.timeKnown(), true);
    assert.equal(r.core.unixSeconds(), 1790000000);
    assert.equal(r.core.localSeconds(), 1790000000 + 7200);
    r.clock.t += 10000;
    assert.equal(r.core.unixSeconds(), 1790000010);
    r.core.setClock(1790000011.5, NaN); // 1.5 s off: no jump, zone kept
    assert.equal(r.core.unixSeconds(), 1790000010);
    assert.equal(r.core.zoneMinutes(), 120);
    r.core.setClock(1790000020, 60); // 10 s off: jump
    assert.equal(r.core.unixSeconds(), 1790000020);
    assert.equal(r.core.zoneMinutes(), 60);
    r.core.setClock(NaN, 0);
    assert.equal(r.core.unixSeconds(), 1790000020, "NaN never sets the clock");
});

test("WLAN downlink JSON values are decoded; own rows are dropped", () => {
    const r = rig();
    const got = [];
    r.core.onText("msg", r.core.WHO_ALL, (t, from) => got.push([t, from]));
    r.wlan(() => r.ok({ cur: 5, rows: [
        ["msg", '"a\\"b \\u00e4 \\ud83d\\ude00"', "0", ""],
        ["msg", "21.5", "77", ""],
        ["msg", '"echo"', DEVICE_ID, ""],
    ] }));
    r.run(300);
    // Device strings are bytes: ä (U+00E4) is one Latin-1 byte like a literal, 😀 is UTF-8.
    assert.deepEqual(got, [['a"b ä ð\u009f\u0098\u0080', "0"], ["21.5", "77"]]);
});

// ---------------------------------------------------------------------------
// handlers, scope, addressee, own values

test("read scope follows the read blocks: d, g, a", () => {
    const r = rig();
    assert.equal(r.core.scopeCode(), "d");
    r.core.read("x", r.core.WHO_ME);
    assert.equal(r.core.scopeCode(), "d", "'only this device' needs no subscription");
    r.core.onNumber("x", r.core.WHO_OTHERS, () => {});
    assert.equal(r.core.scopeCode(), "g");
    r.core.read("x", r.core.WHO_DASHBOARD);
    assert.equal(r.core.scopeCode(), "a");
    const r2 = rig();
    r2.core.onText("x", "12345", () => {});
    assert.equal(r2.core.scopeCode(), "g", "a typed id is a device");
    const r3 = rig();
    r3.core.read("x");
    assert.equal(r3.core.scopeCode(), "a", "'all' wants dashboard and devices");
    const calls = r3.wlan(() => r3.ok());
    r3.run(200);
    assert.equal(calls[0].scope, "a");
});

test("handlers match sender pattern and addressee", () => {
    const r = rig();
    const hits = { dash: [], others: [], butMe: [], typed: [], text: [] };
    r.core.onNumber("temp", r.core.WHO_DASHBOARD, (v, f, t) => hits.dash.push(v));
    r.core.onNumber("temp", r.core.WHO_OTHERS, (v) => hits.others.push(v));
    r.core.onNumber("temp", r.core.WHO_ALL_BUT_ME, (v) => hits.butMe.push(v));
    r.core.onNumber("temp", "777", (v) => hits.typed.push(v));
    r.core.onText("temp", r.core.WHO_ALL, (t) => hits.text.push(t));
    r.core.receive("temp", "1", "0", "");          // dashboard → everyone
    r.core.receive("temp", "2", "777", "");        // device 777 → everyone
    r.core.receive("temp", "3", "555", DEVICE_ID); // device 555 → me
    r.core.receive("temp", "4", "555", "888");     // device 555 → another mini: fires nothing
    r.core.receive("temp", "5", "0", "0");         // to the dashboard: fires nothing
    r.core.receive("temp", "warm", "0", "");       // text: only the text handler
    r.core.receive("Temp", "6", "", "");           // empty sender is the dashboard; key folded
    r.runFibers();
    assert.deepEqual(hits.dash, [1, 6]);
    assert.deepEqual(hits.others, [2, 3]);
    assert.deepEqual(hits.butMe, [1, 2, 3, 6]);
    assert.deepEqual(hits.typed, [2]);
    assert.deepEqual(hits.text, ["1", "2", "3", "warm", "6"]);
    assert.equal(r.core.read("temp", "555", "888"), 4, "addressed elsewhere: still readable explicitly");
});

test("own values are dispatched locally at once: 'all' includes me", () => {
    const r = rig();
    const hits = { all: 0, me: 0, butMe: 0, others: 0, dash: 0, text: [] };
    r.core.onNumber("temp", r.core.WHO_ALL, () => hits.all++);
    r.core.onNumber("temp", r.core.WHO_ME, () => hits.me++);
    r.core.onNumber("temp", r.core.WHO_ALL_BUT_ME, () => hits.butMe++);
    r.core.onNumber("temp", r.core.WHO_OTHERS, () => hits.others++);
    r.core.onNumber("temp", r.core.WHO_DASHBOARD, () => hits.dash++);
    r.core.onText("temp", r.core.WHO_ALL, (t, from) => hits.text.push(from));
    r.core.send("Temp", 21.5);
    assert.equal(r.core.read("temp"), 21.5, "readable right after send, before any request");
    assert.equal(r.core.read("temp", r.core.WHO_ME), 21.5);
    assert.equal(r.core.read("temp", r.core.WHO_DASHBOARD), 0);
    r.runFibers();
    assert.deepEqual(hits, { all: 1, me: 1, butMe: 0, others: 0, dash: 0, text: [DEVICE_ID] });
    r.core.send("temp", 22, "0"); // addressed to the dashboard: not to me
    r.runFibers();
    assert.equal(hits.all, 1);
    assert.equal(r.core.read("temp"), 21.5, "D4: a value to the dashboard is not read without an addressee");
    assert.equal(r.core.read("temp", r.core.WHO_ALL, r.core.WHO_DASHBOARD), 22);
    r.clock.t += 10;
    r.core.send("temp", 23);
    assert.equal(r.core.read("temp"), 23, "the newest value wins in read");
});

test("D4: read without an addressee sees values to everyone or to me; an explicit one means exactly that", () => {
    const r = rig();
    const rx = (v, from, to) => { r.clock.t += 10; r.core.receive("temp", v, from, to); };
    rx("1", "0", "");           // dashboard → everyone
    rx("2", "777", DEVICE_ID);  // device 777 → me
    rx("3", "777", "888");      // device 777 → another mini
    rx("4", "777", "0");        // device 777 → the dashboard
    assert.equal(r.core.read("temp"), 2, "the newest of 'to everyone' and 'to me'");
    assert.equal(r.core.readText("temp"), "2");
    assert.equal(r.core.read("temp", r.core.WHO_ALL, r.core.WHO_ALL), 2, "'all' in the to field is the default rule");
    assert.equal(r.core.read("temp", "0"), 1, "sender filter combines with the default rule");
    assert.equal(r.core.read("temp", r.core.WHO_ALL, "888"), 3, "a typed device id: exactly that addressee");
    assert.equal(r.core.read("temp", r.core.WHO_ALL, r.core.WHO_DASHBOARD), 4);
    assert.equal(r.core.read("temp", r.core.WHO_ALL, r.core.WHO_ME), 2, "explicitly to me");
    assert.equal(r.core.read("temp", "0", r.core.WHO_ME), 0, "a broadcast is not 'explicitly to me'");
    assert.equal(r.core.read("temp", r.core.WHO_ALL, r.core.WHO_OTHERS), 3, "to another device, not to the dashboard");
    assert.equal(r.core.read("temp", r.core.WHO_ALL, r.core.WHO_ALL_BUT_ME), 4, "addressed, but not to me");
    assert.equal(r.core.read("temp", r.core.WHO_ALL, "999"), 0);
    assert.equal(r.core.readText("temp", r.core.WHO_ALL, "999"), "");
    rx("5", "0", "0");          // the dashboard writes to itself: still not "to me"
    assert.equal(r.core.read("temp"), 2);
    rx("6", "777", "");         // a newer broadcast wins again
    assert.equal(r.core.read("temp"), 6);
});

// Without an interval block (D3, v0.1.3): a value after a quiet spell goes at
// once; values that follow within a second of the last request are collected
// until 8 are there or the oldest has waited 5 s (2 s when the program reads).
// The answers carry the clock, otherwise the idle poll would ask for it.
const clockOk = (r) => r.ok({ serverSec: 1790000000, tzoMin: 0 });

test("D3: a value after a quiet spell goes at once", () => {
    const r = rig();
    const calls = r.wlan(() => clockOk(r));
    r.core.send("a", 1);
    r.run(300);
    assert.equal(calls.length, 1);
    r.run(3000); // quiet
    r.core.send("a", 2);
    r.run(300);
    assert.equal(calls.length, 2, "goes at the next tick, no collecting");
    assert.deepEqual(calls[1].values, ["2"]);
});

test("D3: values that come before the next sync are collected and go together then", () => {
    const r = rig();
    const calls = r.wlan(() => clockOk(r));
    r.core.send("a", 1);
    r.run(300);
    assert.equal(calls.length, 1, "the first goes at once");
    r.core.send("a", 2);
    r.run(700);
    r.core.send("a", 3);
    r.run(500);
    assert.equal(calls.length, 1, "collected until the next sync (2 s by default)");
    r.run(800);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].values, ["2", "3"]);
    const g = gaps(calls)[0];
    assert.ok(g >= 2000 && g <= 2200, `the batch left at the next sync: ${g} ms`);
});

test("D3: the sync interval bounds the requests — every minute: one request per minute", () => {
    const r = rig();
    const calls = r.wlan(() => clockOk(r));
    r.core.setSync(60000);
    r.core.send("a", 0);
    r.run(300);
    for (let i = 1; i <= 5; i++) {
        r.core.send("a", i);
        r.run(10000);
    }
    assert.equal(calls.length, 1, "nothing before the minute is over");
    r.run(11000);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].values, ["1", "2", "3", "4", "5"]);
});

test("D3: only send — a program that receives does not ask when it has nothing to send", () => {
    const r = rig();
    const calls = r.wlan(() => clockOk(r));
    r.core.onNumber("licht", r.core.WHO_DASHBOARD, () => {});
    r.core.setSync(2000, true);
    r.run(300); // first request (clock)
    r.run(10000);
    assert.equal(calls.length, 1, "no polls");
    r.core.send("a", 1);
    r.run(300);
    assert.equal(calls.length, 2, "a value still goes at once");
});

test("D3: a full request's worth (8 values) goes at once", () => {
    const r = rig();
    const calls = r.wlan(() => clockOk(r));
    r.core.send("a", 0);
    r.run(300);
    for (let i = 1; i <= 8; i++) r.core.send("f" + i, i);
    r.run(1200); // the floor still applies
    assert.equal(calls.length, 2);
    assert.equal(calls[1].values.length, 8);
});

test("sync of a minute or more: the radio goes off after each sync once nothing waits", () => {
    const r = rig();
    const calls = r.wlan(() => clockOk(r));
    let sleeps = 0;
    r.core.setWlanSleeper(() => sleeps++);
    r.core.setSync(60000);
    r.core.send("a", 1);
    r.run(500);
    assert.equal(calls.length, 1);
    assert.equal(sleeps, 1, "asleep after the sync");
    r.core.send("a", 2);
    r.run(61000);
    assert.equal(calls.length, 2, "the next sync (the sender wakes the module)");
    assert.equal(sleeps, 2);
});

test("sync below a minute: the radio stays on", () => {
    const r = rig();
    r.wlan(() => clockOk(r));
    let sleeps = 0;
    r.core.setWlanSleeper(() => sleeps++);
    r.core.setSync(10000);
    r.core.send("a", 1);
    r.run(25000);
    assert.equal(sleeps, 0);
});

test("the sleep block: no polls until a value comes; that value goes and polling resumes", () => {
    const r = rig();
    const calls = r.wlan(() => clockOk(r));
    let sleeps = 0;
    r.core.setWlanSleeper(() => sleeps++);
    r.core.onNumber("licht", r.core.WHO_DASHBOARD, () => {});
    r.run(300); // first request (clock)
    r.core.sleepNow();
    assert.equal(sleeps, 1);
    const n = calls.length;
    r.run(10000);
    assert.equal(calls.length, n, "no polls while asleep");
    r.core.send("a", 1);
    r.run(300);
    assert.equal(calls.length, n + 1, "the value goes (the sender wakes the module)");
    r.run(4100);
    assert.ok(calls.length >= n + 3, `polls again after the value: ${calls.length - n}`);
});

test("D3: a program that receives asks every sync interval when it has nothing to send", () => {
    const r = rig();
    const calls = r.wlan(() => clockOk(r));
    r.core.onNumber("licht", r.core.WHO_DASHBOARD, () => {});
    r.run(300);
    const before = calls.length;
    r.run(6100);
    assert.equal(calls.length - before, 3, "every 2 s by default");
});

test("own id coming back over any downlink is ignored", () => {
    const r = rig();
    let n = 0;
    r.core.onNumber("temp", r.core.WHO_ALL, () => n++);
    r.core.receive("temp", "9", DEVICE_ID, "");
    r.runFibers();
    assert.equal(n, 0);
    assert.equal(r.core.read("temp"), 0);
});

test("each handler runs in its own fiber; a blocked handler only blocks its own slots", () => {
    const r = rig();
    const stuck = [];
    const fine = [];
    r.core.onNumber("a", r.core.WHO_ALL, (v) => { stuck.push(v); throw PARK; }); // never returns
    r.core.onNumber("b", r.core.WHO_ALL, (v) => fine.push(v));
    for (let i = 0; i < 5; i++) r.core.receive("a", String(i), "0", "");
    r.runFibers();
    assert.deepEqual(stuck, [0, 1], "two slots per handler, the rest waits");
    for (let i = 0; i < 5; i++) r.core.receive("b", String(i), "0", "");
    r.runFibers();
    r.step();
    assert.deepEqual(fine, [0, 1, 2, 3, 4], "other handlers keep running");
    assert.deepEqual(stuck, [0, 1]);
});

// ---------------------------------------------------------------------------
// identity, configuration, text

test("identity: unsigned decimal serial, negative in the simulator, friendly name", () => {
    const r = rig({ serial: -1 });
    assert.equal(r.core.deviceId(), "4294967295");
    const s = rig({ sim: true, serial: 42 });
    assert.equal(s.core.deviceId(), "-42");
    const z = rig({ serial: 0 });
    assert.equal(z.core.deviceId(), "1", "0 would be the dashboard");
    // Reference values computed with mini-connection-widget friendlyNameFromDeviceId.
    const c = rig();
    assert.equal(c.core.friendlyName(0), "zuzuz");
    assert.equal(c.core.friendlyName(1), "zuzuv");
    assert.equal(c.core.friendlyName(4), "zuzut");
    assert.equal(c.core.friendlyName(1790064168), "gevep");
    assert.equal(c.core.friendlyName(0x9a2b3c4d | 0), "titat");
    assert.equal(c.core.friendlyName(-1), "gevaz");
    assert.equal(c.core.deviceName(), "zogop", "the firmware's name wins when it is CVCVC");
    const d = rig({ name: "BBC micro:bit", serial: 0 });
    assert.equal(d.core.deviceName(), "zuzuz");
    assert.equal(rig({ sim: true }).core.deviceName(), "sim-zogop");
});

test("server normalisation and the ingest context", () => {
    const r = rig();
    const n = r.core.normalizeServer;
    assert.equal(n(""), "https://campus-api.calliope.cc/api/iot/v1");
    assert.equal(n("campus-api.calliope.cc"), "https://campus-api.calliope.cc/api/iot/v1");
    assert.equal(n("192.168.1.172:8090"), "http://192.168.1.172:8090/api/iot/v1");
    assert.equal(n("http://localhost:8090/api/iot/v1/"), "http://localhost:8090/api/iot/v1");
    assert.equal(n("HTTPS://example.org/x"), "https://example.org/x");
    const calls = r.wlan(() => r.ok());
    r.core.setDashboard(" demo:R-AAAA:W-BBBB ", "192.168.1.172:8090");
    r.core.send("a", 1);
    r.run(200);
    assert.equal(calls[0].ref, "demo:R-AAAA:W-BBBB");
    assert.equal(calls[0].server, "http://192.168.1.172:8090/api/iot/v1");
    assert.equal(calls[0].dev, DEVICE_ID);
    r.core.setDashboard("other");
    assert.equal(r.core.serverAddress(), "http://192.168.1.172:8090/api/iot/v1", "an omitted server keeps the last");
});

test("values: numbers stay numbers, text is JSON-escaped, NaN and Infinity are 0", () => {
    const r = rig();
    const calls = r.wlan(() => r.ok());
    r.core.setSync(1000);
    r.core.send("n", 21.123456);
    r.core.send("n", NaN);
    r.core.send("n", Infinity);
    r.core.sendText("t", "21");
    r.core.sendText("t", 'say "hi"\\ \n next');
    r.core.sendText("t", "grüße");          // Latin-1 bytes, as a program literal
    r.core.sendText("t", "grÃ¼Ã\u009fe"); // UTF-8 bytes, as text from outside
    r.run(200);
    assert.deepEqual(calls[0].values, [
        "21.123", "0", "0", "21",
        '"say \\"hi\\"\\\\   next"',
        '"gr\\u00fc\\u00dfe"', '"gr\\u00fc\\u00dfe"',
    ]);
    for (const v of calls[0].values) assert.ok(/^[\x20-\x7e]*$/.test(v), "pure ASCII on the wire");
});

test("feed keys: lowercase, ':' → '_', cut at 32; text cut at 160", () => {
    const r = rig();
    assert.equal(r.core.feedKey(" Raum:Temp "), "raum_temp");
    assert.equal(r.core.feedKey("A".repeat(40)).length, 32);
    const calls = r.wlan(() => r.ok());
    r.core.sendText("t", "y".repeat(300));
    r.run(200);
    assert.equal(calls[0].values[0].length, 162);
    // On the device a UTF-8 sequence is never cut in half; Latin-1 bytes are plain chars.
    assert.equal(r.core.cut("a".repeat(159) + "Ã¼", 160).length, 159);
    assert.equal(r.core.cut("a".repeat(159) + "°°", 160).length, 160);
});

test("a scope change during a request starts a fresh snapshot; the old answer's cur is not adopted", () => {
    const r = rig();
    let n = 0;
    const calls = r.wlan(() => (++n === 1 ? r.ok({ cur: 42 }) : r.ok({ cur: 60 + n })));
    r.core.onNumber("x", r.core.WHO_DASHBOARD, () => {});
    r.core.setSync(1000);
    r.run(1200);
    assert.equal(calls[1].since, 42);
    r.step(1000, { fibersToo: false }); // request 3 in flight with since=…
    r.core.onNumber("y", r.core.WHO_OTHERS, () => {}); // wider scope: snapshot wanted
    r.runFibers(); // the in-flight answer brings cur=63 for the OLD question
    r.run(1200);
    const next = calls[calls.length - 1];
    assert.equal(next.scope, "a");
    assert.equal(next.since, 0, "fresh snapshot for the new scope");
});
