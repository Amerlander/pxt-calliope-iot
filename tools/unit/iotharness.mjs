// Test rig for the IoT core (iotcore.ts, iotcampus.ts, iotsim.ts) under Node.
//
// pxt fibers are cooperative and the core loop is `while (true) { pause; tick }`,
// which plain JS cannot run. So:
//   - `control.inBackground(fn)` queues fn; `runFibers()` runs the queue.
//   - `basic.pause` throws PARK: the core loop parks on its first pause and the
//     test drives `iotcore.tick()` itself (`step`). A handler that throws PARK
//     plays a fiber that never returns.
//   - the clock is fake (`clock.t`), the mailbox, serial, BLE and simulator are
//     fakes recording what the device wrote.

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { EXT_DIR, loadExtension, makeShims } from "./loader.mjs";

export const CORE_FILES = ["iottypes.ts", "iotdap.ts", "iotcore.ts", "iotcampus.ts", "iotsim.ts"];
export const PARK = new Error("PARK (fiber parked in basic.pause)");

/** A serial number with the top bit set, as pxt returns it (signed int32). */
export const SERIAL = 0x9a2b3c4d | 0;
export const DEVICE_ID = String(SERIAL >>> 0);

function makeMath(seed) {
    const M = Object.create(Math);
    let s = seed >>> 0;
    M.randomRange = (min, max) => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return min + (s % (max - min + 1));
    };
    // pxt-helpers.ts roundWithPrecision, verbatim.
    M.roundWithPrecision = (x, digits) => {
        digits = digits | 0;
        if (digits <= 0) return Math.round(x);
        if (x == 0) return 0;
        let r = 0;
        do {
            const d = Math.pow(10, digits);
            r = Math.round(x * d) / d;
            digits++;
        } while (r == 0 && digits < 21);
        return r;
    };
    return M;
}

/**
 * A fresh extension instance with fake pxt globals.
 * opts: t0, sim (hardware "0.0"), serial, name, seed, mailboxHost (a DAP host polls the slot).
 */
export function rig(opts = {}) {
    const clock = { t: opts.t0 ?? 1000 };
    const fibers = [];
    const serialWrites = []; // [t, text]
    let serialIn = "";
    const serialCalls = { readString: 0, setRxBufferSize: [] };
    const sim = { sent: [], handlers: {} };

    const shims = makeShims({
        control: {
            millis: () => clock.t,
            inBackground: (fn) => fibers.push(fn),
            deviceSerialNumber: () => opts.serial ?? SERIAL,
            deviceName: () => opts.name ?? "zogop",
            _hardwareVersion: () => (opts.sim ? "0.0" : "3"),
            simmessages: {
                send: (ch, buf) => sim.sent.push([ch, buf === undefined ? undefined : buf.toString()]),
                onReceived: (ch, h) => { sim.handlers[ch] = h; },
            },
        },
        basic: { pause: () => { throw PARK; } },
        serial: {
            writeString: (s) => serialWrites.push([clock.t, s]),
            readString: () => { serialCalls.readString++; const s = serialIn; serialIn = ""; return s; },
            setRxBufferSize: (n) => serialCalls.setRxBufferSize.push(n),
        },
        Buffer: { fromUTF8: (s) => ({ toString: () => s }) },
        Math: makeMath(opts.seed ?? 1),
    });
    const ns = loadExtension(CORE_FILES, shims, "{ iotcore, iotcampus, iotsim, iotdap, iot }");
    const core = ns.iotcore;

    // The mailbox as iotdap.cpp behaves: one slot up (device → host), a
    // queue down; "host seen" once the host emptied a slot or wrote a line.
    const mb = { slot: null, hostSeen: false, received: [], down: [], polling: !!opts.mailboxHost };
    ns.iotdap.schreibe = (line) => {
        if (mb.slot !== null) return false;
        mb.slot = { line, t: clock.t };
        return true;
    };
    ns.iotdap.lies = () => {
        if (!mb.down.length) return "";
        mb.hostSeen = true;
        return mb.down.shift();
    };
    ns.iotdap.hoertJemandZu = () => mb.hostSeen;
    mb.hostPoll = () => {
        if (mb.slot !== null) {
            mb.received.push(mb.slot);
            mb.slot = null;
            mb.hostSeen = true;
        }
    };

    const ble = [];

    function runFibers() {
        let guard = 0;
        while (fibers.length) {
            if (++guard > 10000) throw new Error("fiber storm");
            const fn = fibers.shift();
            try {
                fn();
            } catch (e) {
                if (e !== PARK) throw e;
            }
        }
    }

    /** Advance the clock, run one core tick (and the DAP host's poll every 50 ms), then the fibers. */
    function step(ms = 100, { fibersToo = true } = {}) {
        const before = clock.t;
        clock.t += ms;
        if (mb.polling && Math.floor(before / 50) !== Math.floor(clock.t / 50)) mb.hostPoll();
        core.tick();
        if (fibersToo) runFibers();
    }

    /** Run for `total` ms in steps of `stepMs`. */
    function run(total, stepMs = 100) {
        const end = clock.t + total;
        while (clock.t < end) step(Math.min(stepMs, end - clock.t));
    }

    /** Lines the device wrote on USB serial, without CRLF. */
    function serialLines() {
        return serialWrites.map(([, s]) => s).join("").split("\r\n").filter((l) => l !== "");
    }

    /** Register a fake WLAN sender; `answer(call, n)` returns an Answer (or null). */
    function wlan(answer) {
        const calls = [];
        core.setWlanSender((batch, ctx) => {
            const call = {
                t: clock.t,
                seq: batch.seq,
                feeds: batch.feeds.slice(),
                values: batch.values.slice(),
                tos: batch.tos.slice(),
                ages: batch.ages.slice(),
                labelKeys: batch.labelKeys.slice(),
                labelTexts: batch.labelTexts.slice(),
                ref: ctx.ref, server: ctx.server, dev: ctx.dev, scope: ctx.scope, since: ctx.since, boot: ctx.boot,
                batch,
            };
            calls.push(call);
            return answer(call, calls.length);
        });
        return calls;
    }

    function ok(fields = {}) {
        const a = new core.Answer();
        a.ok = true;
        Object.assign(a, fields);
        if (fields.rows) {
            delete a.rows;
            for (const [f, v, from, to] of fields.rows) {
                a.dFeeds.push(f); a.dValues.push(v); a.dFroms.push(from); a.dTos.push(to ?? "");
            }
        }
        return a;
    }

    function fail(error = "wifi", fields = {}) {
        const a = new core.Answer();
        a.ok = false;
        a.error = error;
        Object.assign(a, fields);
        return a;
    }

    return {
        ns, core, clock, fibers, runFibers, step, run, mb, ble, sim, serialWrites, serialCalls, serialLines,
        feedSerial(s) { serialIn += s; },
        wlan, ok, fail,
    };
}

/**
 * Campus' own wire.ts, transpiled and imported, so the line format is checked
 * against the real parser and builders. Null when the Campus checkout is absent.
 */
export async function loadCampusWire() {
    const file = process.env.CAMPUS_WIRE
        || path.resolve(EXT_DIR, "..", "..", "calliope-campus", "src", "lib", "services", "iot", "wire.ts");
    if (!fs.existsSync(file)) return null;
    const out = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
    });
    const url = "data:text/javascript;base64," + Buffer.from(out.outputText).toString("base64");
    return import(url);
}
