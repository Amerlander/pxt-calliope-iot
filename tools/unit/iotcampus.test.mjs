// Unit tests for the Campus transport (iotcampus.ts) and the simulator path
// (iotsim.ts): line format against Campus' own wire.ts, hello, probe, mailbox
// queue, serial discipline, BLE side channel, simulator panel.
// Run: npm test (in tools/unit)

import { test } from "node:test";
import assert from "node:assert/strict";
import { rig, DEVICE_ID, loadCampusWire } from "./iotharness.mjs";

const wire = await loadCampusWire();
const needWire = { skip: wire ? false : "Campus wire.ts not found next to this repo" };

const SERVER = "http://localhost:8090/api/iot/v1";

// ---------------------------------------------------------------------------
// hello and probe

test("hello: r, i, s, h in this order, deferred past boot", needWire, () => {
    const r = rig({ t0: 0 });
    r.core.setDashboard("demo:R-AAAA:W-BBBB", "localhost:8090");
    r.step(100);
    assert.deepEqual(r.serialLines(), [], "not in the first ms after reset");
    r.run(400);
    const lines = r.serialLines();
    assert.deepEqual(lines, [
        "IOT1:r:d",
        `IOT1:i:${DEVICE_ID}`,
        `IOT1:s:${SERVER}`,
        "IOT1:h:demo:R-AAAA:W-BBBB",
    ]);
    assert.deepEqual(lines.map(wire.parseUplink), [
        { kind: "readScope", scope: "dashboard" },
        { kind: "identity", serial: DEVICE_ID },
        { kind: "server", url: SERVER },
        { kind: "hello", ref: "demo:R-AAAA:W-BBBB" },
    ]);
});

test("hello without a reference says only r and i", () => {
    const r = rig();
    r.core.send("x", 1);
    r.run(300);
    assert.deepEqual(r.serialLines().slice(0, 2), ["IOT1:r:d", `IOT1:i:${DEVICE_ID}`]);
    assert.ok(!r.serialLines().some((l) => l.startsWith("IOT1:h:") || l.startsWith("IOT1:s:")));
});

test("the probe IOT1:? is answered with the hello, on every pipe", needWire, () => {
    const r = rig();
    r.core.setDashboard("demo");
    r.run(300);
    const count = () => r.serialLines().filter((l) => l === "IOT1:h:demo").length;
    assert.equal(count(), 1);
    r.feedSerial(wire.downlinkProbe() + "\r\n");
    r.run(200);
    assert.equal(count(), 2, "serial");
    r.mb.down.push(wire.downlinkProbe());
    r.run(200);
    assert.equal(count(), 3, "mailbox");
    r.ns.iot.empfangeVonAussen(wire.downlinkProbe());
    r.run(200);
    assert.equal(count(), 4, "BLE side channel");
});

test("a scope change restates the hello with the new r:", () => {
    const r = rig();
    r.core.setDashboard("demo");
    r.run(300);
    r.core.onNumber("x", r.core.WHO_OTHERS, () => {});
    r.run(200);
    const rs = r.serialLines().filter((l) => l.startsWith("IOT1:r:"));
    assert.deepEqual(rs, ["IOT1:r:d", "IOT1:r:g"]);
});

// ---------------------------------------------------------------------------
// line format

test("uplink lines parse with Campus wire.ts", needWire, () => {
    const r = rig();
    r.core.setInterval(0);
    r.run(300);
    r.core.send("Temperatur", 21.5);
    r.core.sendText("nachricht", "a:b:c", "0");
    r.core.sendText("Raum:Name", "zwei\nZeilen");
    r.core.log("hallo welt: 1");
    r.run(200);
    const lines = r.serialLines().slice(2); // after r:, i:
    assert.deepEqual(lines, [
        "IOT1:l:hallo welt: 1",
        "IOT1:n:temperatur:Temperatur",
        "IOT1:d::temperatur:21.5",
        "IOT1:d:0:nachricht:a:b:c",
        "IOT1:n:raum_name:Raum_Name",
        "IOT1:d::raum_name:zwei Zeilen",
    ]);
    assert.deepEqual(lines.map(wire.parseUplink), [
        { kind: "log", text: "hallo welt: 1" },
        { kind: "feedName", key: "temperatur", label: "Temperatur" },
        { kind: "data", to: "", feed: "temperatur", value: "21.5" },
        { kind: "data", to: "0", feed: "nachricht", value: "a:b:c" },
        { kind: "feedName", key: "raum_name", label: "Raum_Name" },
        { kind: "data", to: "", feed: "raum_name", value: "zwei Zeilen" },
    ]);
    // Never writeLine: no padding before CRLF.
    for (const [, s] of r.serialWrites) assert.ok(s.endsWith("\r\n") && !s.includes("  \r\n"));
});

test("the spelling goes once per host and again after a hello", () => {
    const r = rig();
    r.core.setInterval(0);
    r.run(300);
    r.core.send("Licht", 1);
    r.run(200);
    r.core.send("Licht", 2);
    r.run(200);
    const n = () => r.serialLines().filter((l) => l === "IOT1:n:licht:Licht").length;
    assert.equal(n(), 1);
    r.ns.iot.empfangeVonAussen("IOT1:?");
    r.run(200);
    r.core.send("Licht", 3);
    r.run(200);
    assert.equal(n(), 2);
});

test("downlink lines built by Campus wire.ts reach cache, handlers and clock", needWire, () => {
    const r = rig();
    const got = [];
    r.core.onNumber("sollwert", r.core.WHO_ALL, (v, from, to) => got.push([v, from, to]));
    r.core.onNumber("pumpe", r.core.WHO_DASHBOARD, (v, from, to) => got.push([v, from, to]));
    r.core.onText("msg", r.core.WHO_ALL, (t) => got.push([t]));
    r.run(300);
    r.mb.down.push(wire.downlinkValue({ from: "123", to: "", feed: "Sollwert", value: 7 }));
    r.mb.down.push(wire.downlinkValue({ from: "", to: DEVICE_ID, feed: "pumpe", value: true }));
    r.mb.down.push(wire.downlinkValue({ from: "0", to: "", feed: "msg", value: "a:b" }));
    for (const l of wire.downlinkTime(1790000000, 120)) r.mb.down.push(l);
    r.run(300);
    assert.deepEqual(got, [[7, "123", ""], [1, "0", DEVICE_ID], ["a:b"]]);
    assert.equal(r.core.read("sollwert", "123"), 7);
    assert.equal(r.core.timeKnown(), true);
    assert.equal(r.core.unixSeconds(), 1790000000);
    assert.equal(r.core.zoneMinutes(), 120);
    assert.equal(r.core.status(), r.core.STATE_CONNECTED);
    r.mb.down.push(wire.downlinkError("too_fast"));
    r.run(200);
    assert.equal(r.core.status(), r.core.STATE_ERROR);
    assert.equal(r.core.lastError(), "too_fast");
    // Legacy clock line with the zone appended.
    r.ns.iot.empfangeVonAussen("IOT1:t:1790000100:60");
    assert.equal(r.core.unixSeconds(), 1790000100);
    assert.equal(r.core.zoneMinutes(), 60);
});

test("onSent fires on the Campus path when the line leaves", () => {
    const r = rig();
    const sent = [];
    r.core.onSent("", (feed, v, to) => sent.push([feed, v, to]));
    r.core.setInterval(2000);
    r.run(300);
    r.core.send("a", 5, "0");
    r.run(500);
    assert.deepEqual(sent, [], "still in the buffer");
    r.run(2000);
    assert.deepEqual(sent, [["a", 5, "0"]]);
});

// ---------------------------------------------------------------------------
// mailbox queue

test("back-to-back lines all reach a mailbox host polling every 50 ms, in order, with serial in step", () => {
    const r = rig({ t0: 0, mailboxHost: true });
    r.core.setDashboard("demo");
    r.core.setInterval(0);
    for (let i = 0; i < 20; i++) r.core.send("burst", i);
    r.run(3000, 10);
    const got = r.mb.received.map((x) => x.line);
    const want = ["IOT1:r:d", `IOT1:i:${DEVICE_ID}`, `IOT1:s:https://campus-api.calliope.cc/api/iot/v1`, "IOT1:h:demo",
        ...Array.from({ length: 20 }, (_, i) => `IOT1:d::burst:${i}`)];
    assert.deepEqual(got, want, "nothing lost through the one slot");
    assert.deepEqual(r.serialLines(), want, "serial carries the same lines in the same order");
    // Each serial copy left in the same tick its mailbox copy was taken.
    for (let i = 0; i < want.length; i++) {
        assert.equal(r.serialWrites[i][0], r.mb.received[i].t, `line ${i} copies in step`);
    }
});

test("without a mailbox host lines wait once (120 ms), then flow freely", () => {
    const r = rig({ t0: 0 });
    r.core.setInterval(0);
    for (let i = 0; i < 10; i++) r.core.send("x", i);
    r.run(1000, 10);
    assert.equal(r.serialLines().length, 12, "hello (2) + 10 points");
    const first = r.serialWrites[0][0];
    const last = r.serialWrites[11][0];
    assert.ok(last - first <= 150, `all out within ${last - first} ms`);
    assert.equal(r.mb.slot.line, "IOT1:r:d", "only the first line sits in the unread slot");
});

test("a host that stops draining is given up on after 250 ms and picked up again", () => {
    const r = rig({ t0: 0, mailboxHost: true });
    r.core.setInterval(0);
    r.run(500, 10);
    r.mb.polling = false; // cable pulled
    for (let i = 0; i < 5; i++) r.core.send("a", i);
    r.run(1000, 10);
    const sent = r.serialLines().filter((l) => l.startsWith("IOT1:d::a:"));
    assert.equal(sent.length, 5, "serial keeps flowing");
    const ts = r.serialWrites.filter(([, s]) => s.startsWith("IOT1:d::a:")).map(([t]) => t);
    assert.ok(ts[4] - ts[0] <= 300, `one wait at most: ${ts[4] - ts[0]} ms`);
    r.mb.polling = true; // back
    r.run(100, 10);
    r.core.send("b", 1);
    r.core.send("b", 2);
    r.run(500, 10);
    const tail = r.mb.received.map((x) => x.line).slice(-2);
    assert.deepEqual(tail, ["IOT1:d::b:1", "IOT1:d::b:2"]);
});

// ---------------------------------------------------------------------------
// serial discipline

test("serial: lines may arrive in pieces; a 26-byte line fits the raised RX buffer", () => {
    const r = rig();
    const got = [];
    r.core.onNumber("licht", r.core.WHO_ALL, (v, from) => got.push([v, from]));
    r.run(300);
    assert.deepEqual(r.serialCalls.setRxBufferSize, [128]);
    r.feedSerial("IOT1:v:-957520046::Li");
    r.step();
    r.feedSerial("cht:1\r\nIOT1:v:0::licht:0\n");
    r.step();
    assert.deepEqual(got, [[1, "-957520046"], [0, "0"]]);
});

test("serial: the connection widget's 'H' probe is not a foreign line; IOT1:? is still answered", () => {
    // The widget writes "H\n" over USB serial after every flash
    // (mini-connection-widget usb.ts primeBlocksRuntimeProbe) to detect the
    // Blocks runtime. Taking that for a program's own input would drop the
    // serial downlink for good, and Campus' probe IOT1:? (sent over serial
    // only) would never be answered: a tab connecting after boot gets no hello.
    const r = rig();
    r.core.setDashboard("demo");
    r.run(300);
    const hellos = () => r.serialLines().filter((l) => l === "IOT1:h:demo").length;
    assert.equal(hellos(), 1);
    r.feedSerial("H\n");
    r.run(100);
    r.feedSerial("H"); // also in pieces
    r.run(50);
    r.feedSerial("\r\nIOT1:?\r\n");
    r.run(300);
    assert.equal(hellos(), 2, "the probe after H is answered");
});

test("serial: the first foreign line makes the extension let go of serial for good", () => {
    const r = rig();
    r.core.start();
    r.run(300);
    r.feedSerial("hello from the program\n");
    r.step();
    const reads = r.serialCalls.readString;
    r.feedSerial("IOT1:?\n");
    r.run(500);
    assert.equal(r.serialCalls.readString, reads, "readString is never called again");
    assert.equal(r.serialLines().filter((l) => l.startsWith("IOT1:r:")).length, 1, "the probe was not taken");

    const r2 = rig();
    r2.core.start();
    r2.run(300);
    r2.feedSerial("abc"); // no newline yet, but it can never become an IOT1 line
    r2.step();
    const reads2 = r2.serialCalls.readString;
    r2.run(300);
    assert.equal(r2.serialCalls.readString, reads2);
});

test("WLAN path: serial is neither read nor written; v lines from other pipes are ignored", () => {
    const r = rig();
    r.wlan(() => r.ok({ serverSec: 1790000000 }));
    const got = [];
    r.core.onNumber("x", r.core.WHO_ALL, (v) => got.push(v));
    const ble = [];
    r.ns.iot.setzeZusatzKanal((l) => ble.push(l));
    r.core.send("x", 1);
    r.core.log("protokoll");
    r.run(1000);
    assert.equal(r.serialCalls.readString, 0, "no serial reader");
    assert.deepEqual(r.serialLines(), [], "no serial writes");
    assert.deepEqual(ble, ["IOT1:l:protokoll"], "only the log line goes to the other pipes");
    assert.ok(r.mb.slot && r.mb.slot.line === "IOT1:l:protokoll");
    r.ns.iot.empfangeVonAussen("IOT1:v:0::x:5");
    r.ns.iot.empfangeVonAussen("IOT1:?");
    r.run(500);
    assert.deepEqual(got, [1], "only the own value; the side-channel value is not a second downlink");
    assert.ok(!ble.some((l) => l.startsWith("IOT1:r:")), "no hello on the WLAN path");
});

test("BLE side channel gets every line; values from it are handled", () => {
    const r = rig();
    const ble = [];
    r.ns.iot.setzeZusatzKanal((l) => ble.push(l));
    const got = [];
    r.core.onNumber("soll", r.core.WHO_ALL, (v) => got.push(v));
    r.core.setInterval(0);
    r.run(300);
    r.core.send("a", 1);
    r.run(100);
    r.ns.iot.empfangeVonAussen("IOT1:v:0::soll:3\r");
    r.runFibers();
    assert.deepEqual(ble, ["IOT1:r:a", `IOT1:i:${DEVICE_ID}`, "IOT1:d::a:1"]);
    assert.deepEqual(got, [3]);
});

// ---------------------------------------------------------------------------
// simulator

test("simulator: panel launched on the repo key once a dashboard is named, data on 'iot'", () => {
    const r = rig({ sim: true, serial: 42 });
    r.core.send("a", 1);
    r.run(400);
    assert.deepEqual(r.sim.sent, [], "no panel for a program without a dashboard");
    r.core.setDashboard("demo:R-AAAA:W-BBBB");
    r.core.send("a", 2);
    r.run(6000);
    assert.deepEqual(r.sim.sent[0], ["amerlander/pxt-calliope-iot", undefined]);
    const data = r.sim.sent.slice(1);
    assert.ok(data.every(([ch]) => ch === "iot"));
    assert.deepEqual(data.map(([, l]) => l), [
        "IOT1:r:d", "IOT1:i:-42", "IOT1:s:https://campus-api.calliope.cc/api/iot/v1", "IOT1:h:demo:R-AAAA:W-BBBB",
        "IOT1:d::a:1", "IOT1:d::a:2", // a:1 waited in the buffer until the panel existed
    ]);
});

test("simulator: the panel's own-value echo is ignored, other values and the clock arrive", () => {
    const r = rig({ sim: true, serial: 42 });
    const got = [];
    r.core.onNumber("temp", r.core.WHO_ALL, (v, from) => got.push([v, from]));
    r.core.setDashboard("demo");
    r.run(400);
    const panel = r.sim.handlers.iot;
    assert.ok(panel, "listening on the data channel");
    r.core.send("temp", 21);
    r.runFibers();
    // The panel reads without dev: it returns the device's own value with the rest.
    panel({ toString: () => "IOT1:v:-42::temp:21\nIOT1:v:0::temp:18\r\nIOT1:v:-7::temp:19\nIOT1:t:1790000000\nIOT1:z:120" });
    r.runFibers();
    assert.deepEqual(got, [[21, "-42"], [18, "0"], [19, "-7"]], "own value once (local), never the echo");
    assert.equal(r.core.timeKnown(), true);
});

test("simulator: a registered WLAN sender is ignored, the panel is the transport", () => {
    const r = rig({ sim: true, serial: 42 });
    const calls = r.wlan(() => r.ok());
    r.core.setDashboard("demo");
    r.core.setInterval(0);
    r.core.send("a", 1);
    r.run(600);
    assert.equal(calls.length, 0);
    assert.ok(r.sim.sent.some(([, l]) => l === "IOT1:d::a:1"));
});
