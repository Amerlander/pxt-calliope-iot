// Recovery of a silent module (wlanclient.ts recover()/unwedge()).
// Run: npm test   (in tools/unit)
//
// The module keeps its power when the Calliope is reset or reflashed, so the
// new program can meet it in a state it did not cause: still waiting for the
// data of a send that was cut off after the '>', in transparent mode, deaf to
// AT, or gone. Observed on hardware: five days silent, only a power cycle
// helped (docs/measurement-p2-p3.md §0). fakenet.mjs models these states.

import { test } from "node:test";
import assert from "node:assert/strict";
import { wifiRig } from "./fakewlan.mjs";

const WAKING = 1;
const BEGIN = 5000; // iotwlan.begin() opens the UART at 5 s uptime

const rawBytes = (k) => k.wlan.raws.reduce((n, r) => n + r.data.length, 0);

/** Run until lastError() is `err` (or the time is up); returns ms since the UART opened. */
function until(k, err, limit = 90000) {
    while (k.wifi.lastError() !== err && k.clock.t < limit) k.run(100);
    return k.clock.t - BEGIN;
}

test("rung a: a CIPSEND still waiting for 4000 bytes is completed with CRLF filler", () => {
    const k = wifiRig();
    k.net.wedgePrompt(4000);
    assert.equal(k.online(), true);
    assert.equal(k.wifi.recoveryRung(), "filler");
    assert.equal(k.wifi.recoveryRuns(), 1);
    assert.equal(k.wifi.lastError(), "");
    // the swallowed payload is only our probes and filler: no command could form in it
    const garbage = k.net.unwedged.data;
    assert.equal(garbage.length, 4000);
    assert.match(garbage, /^(AT\r\n)*(\r\n)*$/);
    // stopped writing soon after the module spoke again
    const raw = rawBytes(k);
    assert.ok(raw >= 4000 - 6 * 4 && raw <= 4000 + 512, `filler ${raw} bytes`);
    assert.ok(k.wlan.raws.every((r) => /^(\r\n)+$/.test(r.data)));
    assert.ok(k.wifi.recoveryMs() < 3500, `ladder took ${k.wifi.recoveryMs()} ms`);
    assert.ok(k.lines().includes("AT+CIPRECVMODE=1"), "the bring-up went on");
});

test("rung a: an HTTPCPOST waiting for 8000 bytes; busy while it posts the garbage, then answers", () => {
    const k = wifiRig();
    k.net.wedgePrompt(8000, "httpcpost");
    assert.equal(k.online(), true);
    assert.equal(k.wifi.recoveryRung(), "filler");
    assert.ok(k.wlan.stats(2) > 0, "busy p... was seen and waited out");
    assert.ok(rawBytes(k) <= 8000 + 512);
});

test("rung a also when the firmware answers empty lines with ERROR", () => {
    const k = wifiRig({ blankLines: "error" });
    k.net.wedgePrompt(1000);
    assert.equal(k.online(), true);
    assert.equal(k.wifi.recoveryRung(), "filler");
    assert.ok(rawBytes(k) <= 1000 + 512, "the first ERROR stops the filler");
});

test("rung b: transparent mode is left with a lone +++ and 1.1 s of silence around it", () => {
    const k = wifiRig();
    k.net.wedgeTransparent();
    assert.equal(k.online(), true);
    assert.equal(k.wifi.recoveryRung(), "+++");
    assert.equal(k.net.plusExits, 1);
    const tx = k.net.tx;
    const i = tx.findIndex((w) => w.data === "+++");
    assert.ok(i > 0);
    assert.ok(tx[i].t - tx[i - 1].t >= 1100, `silence before: ${tx[i].t - tx[i - 1].t} ms`);
    assert.ok(tx[i + 1].t - tx[i].t >= 1100, `silence after: ${tx[i + 1].t - tx[i].t} ms`);
    assert.ok(k.lines().includes("AT+CIPMODE=0"), "transparent mode switched off for good");
    assert.equal(rawBytes(k), 8448 + 3, "transparent mode swallowed the whole filler, then +++");
    assert.ok(k.wifi.recoveryBytes() < 16, "only the OK to the final AT");
    assert.ok(k.wifi.recoveryMs() < 8000, `ladder took ${k.wifi.recoveryMs()} ms`);
});

test("rung c: alive but every command answers ERROR: AT+RST and ready bring it back", () => {
    const k = wifiRig();
    k.net.wedgeErroring();
    assert.equal(k.online(), true);
    assert.equal(k.wifi.recoveryRung(), "reset");
    assert.ok(k.wifi.recoveryBytes() > 0);
    assert.equal(k.wifi.recoveryRuns(), 1);
    assert.equal(k.wifi.lastError(), "", "our own reset is no module-reset failure of the bring-up");
    assert.equal(k.wlan.stats(1), 1, "one reset: ours");
});

test("silent module: no-module after one bounded attempt, no AT+RST into the void, retried later", () => {
    const k = wifiRig();
    k.net.silence();
    k.connect();
    const took = until(k, "no-module");
    assert.ok(took <= 15000, `gave up after ${took} ms`);
    assert.equal(k.wifi.recoveryRung(), "none");
    assert.equal(k.wifi.recoveryBytes(), 0);
    assert.equal(k.wifi.state(), WAKING);
    assert.ok(rawBytes(k) >= 8192, "the whole filler went out");
    assert.ok(!k.net.tx.some((w) => w.data.includes("AT+RST")), "nothing heard: AT+RST is pointless");
    k.run(30000);
    assert.ok(k.wifi.recoveryRuns() >= 2, "the next bring-up attempt runs the ladder again");
});

test("noise (boot loop, wrong baud): bytes heard, AT+RST tried, no-module within ~15 s", () => {
    const k = wifiRig();
    k.net.noise();
    k.connect();
    const took = until(k, "no-module");
    assert.ok(took <= 15500, `gave up after ${took} ms`);
    assert.equal(k.wifi.recoveryRung(), "none");
    assert.ok(k.wifi.recoveryBytes() > 0, "recoveryBytes tells it apart from a dead module");
    assert.ok(k.net.tx.some((w) => w.data === "AT+RST\r\n"));
    assert.ok(rawBytes(k) <= 512, "the first noise stopped the filler");
});

test("a recovered module comes back after a silent spell (power restored)", () => {
    const k = wifiRig();
    k.net.silence();
    k.connect();
    until(k, "no-module");
    k.net.mode = "";
    k.run(40000);
    assert.equal(k.wifi.isOnline(), true);
});

test("busy at bring-up is alive: module-busy, no ladder, online once it is done", () => {
    const k = wifiRig();
    k.clock.at(4999, () => { k.fake.busyUntil = k.clock.t + 25000; });
    k.connect();
    const took = until(k, "module-busy");
    assert.ok(took < 15000);
    assert.equal(k.wifi.recoveryRuns(), 0);
    k.run(40000);
    assert.equal(k.wifi.isOnline(), true);
    assert.equal(k.wifi.recoveryRuns(), 0);
    assert.equal(k.wlan.raws.length, 0);
});

test("a send that times out after the prompt is followed by filler: the module is never left waiting", () => {
    const k = wifiRig();
    assert.equal(k.online(), true);
    // 10 bytes lost on the wire: the module keeps waiting after our body
    k.fake.on(/^AT\+HTTPCPOST="[^"]+",(\d+)/, (l, m, f) => f.prompt(+m[1] + 10, () => f.reply([[5, "SEND FAIL\r\n"]])));
    const a = k.post(k.batch(1), k.ctx());
    assert.deepEqual([a.ok, a.error], [false, "timeout"]);
    assert.equal(k.fake.dataLeft, 0, "the filler completed the send");
    k.fake.handlers.pop();
    k.run(1500);
    assert.equal(k.post(k.batch(2), k.ctx()).ok, true, "the next post goes through");

    k.wifi.preferTcp(true);
    k.fake.on(/^AT\+CIPSEND=(\d+)$/, (l, m, f) => f.prompt(+m[1] + 10, () => f.reply([[5, "SEND FAIL\r\n"]])));
    k.run(1500);
    const b = k.post(k.batch(3), k.ctx());
    assert.deepEqual([b.ok, b.error], [false, "timeout"]);
    assert.equal(k.fake.dataLeft, 0);
    k.fake.handlers.pop();
    k.run(1500);
    assert.equal(k.post(k.batch(4), k.ctx()).ok, true);
    assert.equal(k.wifi.recoveryRuns(), 0, "no ladder was needed afterwards");
});

// ---------------------------------------------------------------------------
// The module unplugged and plugged in again while the program runs
// ---------------------------------------------------------------------------

const ONLINE = 3;

/** Unplugged: no power, so not one byte comes back. */
function unplug(k) {
    k.net.silence();
    k.net.joined = null;
    k.net.link = null;
}

/** Plugged in again: it boots and, with `ready`, prints "ready" (a lost line without). */
function plugIn(k, ready = true) {
    k.net.mode = "";
    if (ready) k.net.reboot(400);
    else {
        k.net.joined = null;
        k.fake.echo = true;
    }
}

test("unplugged while online: the first request that hears nothing goes back to the bring-up, the next say offline at once", () => {
    const k = wifiRig();
    assert.equal(k.online(), true);
    unplug(k);
    const a = k.post(k.batch(1), k.ctx());
    assert.deepEqual([a.ok, a.error], [false, "no-module"]);
    assert.equal(k.wifi.state(), WAKING);
    assert.equal(k.wifi.lastError(), "no-module");
    k.run(2000);
    const t = k.clock.t;
    const b = k.post(k.batch(2), k.ctx());
    assert.deepEqual([b.ok, b.error, k.clock.t - t], [false, "offline", 0], "no second 15 s timeout");
});

test("plugged in again: its ready brings it up and into the network within seconds", () => {
    const k = wifiRig();
    assert.equal(k.online(), true);
    unplug(k);
    k.post(k.batch(1), k.ctx());
    k.run(120000); // the bring-up has backed off to 30 s by now
    assert.equal(k.wifi.state(), WAKING);
    const joins = k.net.joins.length;
    plugIn(k);
    const t = k.clock.t;
    while (!k.wifi.isOnline() && k.clock.t - t < 60000) k.run(100);
    assert.ok(k.clock.t - t < 5000, `online after ${k.clock.t - t} ms`);
    assert.equal(k.net.joins.length, joins + 1, "joined again");
    assert.equal(k.post(k.batch(2), k.ctx()).ok, true);
});

test("plugged in again without a ready heard: a value to send makes it try at once, not after the back-off", () => {
    const k = wifiRig();
    assert.equal(k.online(), true);
    unplug(k);
    k.post(k.batch(1), k.ctx());
    k.run(120000);
    plugIn(k, false);
    k.run(500);
    assert.equal(k.wifi.state(), WAKING, "nothing told the client yet");
    assert.equal(k.post(k.batch(2), k.ctx()).error, "offline");
    const t = k.clock.t;
    while (!k.wifi.isOnline() && k.clock.t - t < 60000) k.run(100);
    assert.ok(k.clock.t - t < 8000, `online after ${k.clock.t - t} ms`);
    assert.equal(k.post(k.batch(3), k.ctx()).ok, true);
});

test("unplugged while idle: the link check notices it within ~35 s", () => {
    const k = wifiRig();
    assert.equal(k.online(), true);
    const t = k.clock.t;
    unplug(k);
    while (k.wifi.state() === ONLINE && k.clock.t - t < 120000) k.run(100);
    assert.ok(k.clock.t - t <= 35000, `noticed after ${k.clock.t - t} ms`);
    assert.equal(k.wifi.lastError(), "no-module");
});

test("unplugged while asleep: the wake-up join hears nothing and goes back to the bring-up", () => {
    const k = wifiRig();
    assert.equal(k.online(), true);
    k.wifi.sleep();
    unplug(k);
    const a = k.post(k.batch(1), k.ctx());
    assert.deepEqual([a.ok, a.error], [false, "offline"]);
    k.run(5000);
    assert.equal(k.wifi.state(), WAKING);
    assert.equal(k.wifi.lastError(), "no-module");
    plugIn(k);
    k.run(10000);
    assert.equal(k.wifi.state(), ONLINE);
});

test("each time the client reaches the network, it tells the core", () => {
    const k = wifiRig();
    assert.equal(k.core.wlanOnlineCount(), 0);
    assert.equal(k.online(), true);
    assert.equal(k.core.wlanOnlineCount(), 1);
    unplug(k);
    k.post(k.batch(1), k.ctx());
    plugIn(k);
    k.run(10000);
    assert.equal(k.core.wlanOnlineCount(), 2);
});
