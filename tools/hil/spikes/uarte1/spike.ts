// Spike only — not part of the extension. Shims into spike.cpp.
namespace uarte1spike {
    /** Open a serial port on UARTE1. Returns 1 on success, negative on failure. */
    //% shim=uarte1spike::begin
    export function begin(tx: number, rx: number, baud: number): number { return -99 }
    /** Everything buffered on UARTE1 right now. */
    //% shim=uarte1spike::readAll
    export function readAll(): string { return "" }
    //% shim=uarte1spike::writeStr
    export function writeStr(s: string): void { }
    /** Base address of the UARTE instance the allocator handed out (0 if none). */
    //% shim=uarte1spike::instance
    export function instance(): number { return 0 }
}
