/**
 * Native AT driver: thin shims into wlanport.cpp (engine: wlanat.cpp).
 *
 * On the device every call goes straight to C++; the function bodies here run
 * only in the simulator, which has no WiFi module, so they answer "not open /
 * nothing there". Deliberately no logic in this file: on the mini 2 every
 * byte of TypeScript comes out of the ~22 KB the child's program also needs.
 *
 * Results of command()/sendData() stay readable (lineCount, line, findLine,
 * payload, resultFlags) until the next command starts.
 */
const enum IotAtResult {
    OK = 0,
    Error = 1,
    Fail = 2,
    Timeout = 3,
    Busy = 4,
}

namespace iotwlan {
    /** Open the module UART (waits until 5 s uptime). 1 own UART (mini 3), 2 redirected, < 0 error. */
    //% shim=iotwlan::begin
    export function begin(tx: number, rx: number, baud: number): number { return -1 }

    /** AT command without CRLF; returns an IotAtResult. */
    //% shim=iotwlan::command
    export function command(cmd: string, timeoutMs: number): number { return IotAtResult.Error }

    /** Two-phase send (CIPSEND/HTTPCPOST): `data` goes out only after the prompt. */
    //% shim=iotwlan::sendData
    export function sendData(cmd: string, data: string, timeoutMs: number): number { return IotAtResult.Error }

    /** Flags of the last result: 1 data sent, 2 module reset, 4 truncated. */
    //% shim=iotwlan::resultFlags
    export function resultFlags(): number { return 0 }

    //% shim=iotwlan::lineCount
    export function lineCount(): number { return 0 }

    //% shim=iotwlan::line
    export function line(i: number): string { return "" }

    //% shim=iotwlan::findLine
    export function findLine(prefix: string): string { return "" }

    //% shim=iotwlan::payloadLength
    export function payloadLength(): number { return 0 }

    /** Up to `max` payload bytes from `offset` (at most 200 per call on the mini 2). */
    //% shim=iotwlan::payload
    export function payload(offset: number, max: number): string { return "" }

    //% shim=iotwlan::recvAvailable
    export function recvAvailable(): number { return 0 }

    //% shim=iotwlan::recvTake
    export function recvTake(max: number): string { return "" }

    //% shim=iotwlan::waitRecv
    export function waitRecv(minBytes: number, timeoutMs: number): boolean { return false }

    /** Oldest URC as kind + 256 * value, 0 if none. */
    //% shim=iotwlan::takeUrc
    export function takeUrc(): number { return 0 }

    /** 1 WiFi connected, 2 got IP, 4 link open, 8 echo on, 16 port open. */
    //% shim=iotwlan::status
    export function status(): number { return 0 }

    /** AT+GMR: flags + 256 * family + 65536 * major version. */
    //% shim=iotwlan::detect
    export function detect(timeoutMs: number): number { return 0 }

    /** 0 AT version, 1 chip, 2 bin version (from the last detect). */
    //% shim=iotwlan::moduleInfo
    export function moduleInfo(which: number): string { return "" }

    //% shim=iotwlan::wake
    export function wake(attempts: number, perTryMs: number): boolean { return false }

    //% shim=iotwlan::echoOff
    export function echoOff(timeoutMs: number): boolean { return false }

    //% shim=iotwlan::pumpFor
    export function pumpFor(ms: number): void { }

    /** Bytes to the module as they are (no CRLF, no transaction); false while a transaction runs. */
    //% shim=iotwlan::writeRaw
    export function writeRaw(data: string): boolean { return false }

    /** Diagnosis counters, see wlanport.cpp stats(); 9 = bytes received since begin, 10 = TX path, 11 = DMA stuck count. */
    //% shim=iotwlan::stats
    export function stats(which: number): number { return 0 }

    /** 0 poll ms, 1 busy retries, 2 busy delay ms; 3 = HIL A/B test only (see wlanport.cpp). */
    //% shim=iotwlan::configure
    export function configure(which: number, value: number): void { }
}
