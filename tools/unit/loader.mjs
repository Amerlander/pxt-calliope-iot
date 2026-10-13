// Loads extension sources (pxt Static TypeScript, namespaces, no modules) into Node.
//
// Each file is transpiled on its own with ts.transpileModule (no type check; the
// pxt build is the type check) and all of them are evaluated together inside one
// function whose parameters are the pxt globals the files touch. Evaluating in
// this realm (vm.runInThisContext) keeps arrays/objects comparable with
// assert.deepStrictEqual.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// IOT_EXT_DIR lets a mutation run point the tests at modified copies of the sources.
export const EXT_DIR = process.env.IOT_EXT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Files of the AT stack, in pxt.json order. */
export const WLAN_FILES = ["wlanport.ts", "wlanat.ts"];

/**
 * Minimal pxt globals. Only what the listed files reference; anything the
 * tests do not exercise throws, so an accidental device call is loud.
 */
export function makeShims(overrides = {}) {
    const serialLog = [];
    let rx = "";
    const serial = {
        log: serialLog,
        feedRx(s) { rx += s; },
        redirect(tx, rxPin, baud) { serialLog.push(["redirect", tx, rxPin, baud]); },
        setRxBufferSize(n) { serialLog.push(["setRxBufferSize", n]); },
        writeString(s) { serialLog.push(["writeString", s]); },
        readString() { const s = rx; rx = ""; return s; },
    };
    const notOnNode = (name) => () => { throw new Error(`${name} is device-only in the unit tests`); };
    return {
        serial,
        control: { millis: notOnNode("control.millis"), inBackground: notOnNode("control.inBackground") },
        basic: { pause: notOnNode("basic.pause") },
        SerialPin: { C16: 116, C17: 117 },
        BaudRate: { BaudRate115200: 115200 },
        ...overrides,
    };
}

/**
 * Transpile + evaluate; returns the value of `returns`, an expression evaluated
 * inside the loaded sources — by default the `iotwlan` namespace object. Pass
 * e.g. "{ iotcore, iotwifi }" to get several namespaces at once. Tests that
 * need extra pxt globals pass them in `shims` (makeShims({ name: value })).
 */
export function loadExtension(files = WLAN_FILES, shims = makeShims(), returns = "iotwlan") {
    let js = "";
    for (const f of files) {
        const src = fs.readFileSync(path.join(EXT_DIR, f), "utf8");
        const out = ts.transpileModule(src, {
            fileName: f,
            reportDiagnostics: true,
            compilerOptions: {
                target: ts.ScriptTarget.ES2019,
                module: ts.ModuleKind.None,
                // pxt files are scripts sharing one global namespace
                isolatedModules: false,
            },
        });
        const diags = (out.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
        if (diags.length) {
            const msg = diags.map((d) => `${f}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`).join("\n");
            throw new Error(msg);
        }
        js += `// ---- ${f}\n${out.outputText}\n`;
    }
    const names = Object.keys(shims);
    const wrapper = `(function (${names.join(", ")}) {\n${js}\nreturn (${returns});\n})`;
    const fn = vm.runInThisContext(wrapper, { filename: "iot-extension.js" });
    return fn(...names.map((n) => shims[n]));
}
