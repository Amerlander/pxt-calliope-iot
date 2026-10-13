/**
 * REFERENCE IMPLEMENTATION, not part of the package (not in pxt.json): the
 * device port is wlanport.cpp now. Kept for the Node tests of wlanat.ts.
 *
 * Port: the one and only gateway between the extension and the UART that
 * talks to the WiFi module.
 *
 * Rule (plan §2.1, "exclusive UART"): while WiFi is active, THIS FILE is the
 * only place in the extension that touches `serial` for the module. Nothing
 * else may call `serial.writeString`, `serial.readString`, `serial.readUntil`
 * or register `serial.onDataReceived`. Every past failure of the old drivers
 * came from a second reader stealing lines or a second writer injecting text
 * into the AT stream; keeping all access here makes that structurally
 * impossible instead of relying on scattered "does WiFi own the UART?" checks.
 *
 * The AT engine (wlanat.ts) only sees the `Port` interface, so it can be
 * driven by a fake module in the Node unit tests and, later, by a native
 * UARTE1 port on the mini 3 without any change to the engine.
 */
namespace iotwlan {
    /**
     * Byte pipe to the module. Strings are byte strings: the calliopemini
     * target compiles with utf8=false, so one character is one UART byte and
     * the length-framed AT payloads can be counted with `.length`.
     */
    export interface Port {
        /** Queue bytes for transmission. May block until they fit the TX buffer. */
        write(data: string): void;
        /** Return whatever has been received since the last call, "" if nothing. Never blocks. */
        read(): string;
    }

    /**
     * RX buffer size requested from the runtime. The runtime stores `size + 1`
     * in a uint8, so 255 would wrap to 0; 254 is the largest safe value.
     * At 115200 baud (~11.5 bytes/ms) this buffer fills in ~22 ms, which is
     * the hard upper bound for the time between two reads while the module
     * is streaming. The engine pumps every ~1 ms during a transaction.
     */
    export const RX_BUFFER_SIZE = 254;

    /**
     * Port on the pxt `serial` API, redirected to the module's pins.
     * Works on both boards (mini 2 / DAL and mini 3 / CODAL). On the mini 2
     * this is the only UART, so USB serial is unusable while it is open.
     */
    export class SerialPort implements Port {
        private tx: SerialPin;
        private rx: SerialPin;
        private baud: BaudRate;
        private opened: boolean;

        constructor(tx: SerialPin, rx: SerialPin, baud: BaudRate) {
            this.tx = tx;
            this.rx = rx;
            this.baud = baud;
            this.opened = false;
        }

        /**
         * Take over the UART. Idempotent. The RX buffer is resized after the
         * redirect so it is (re)allocated for the pins the module is on.
         */
        open(): void {
            if (this.opened) return;
            serial.redirect(this.tx, this.rx, this.baud);
            serial.setRxBufferSize(RX_BUFFER_SIZE);
            this.opened = true;
        }

        isOpen(): boolean {
            return this.opened;
        }

        write(data: string): void {
            if (!this.opened || data.length == 0) return;
            serial.writeString(data);
        }

        read(): string {
            if (!this.opened) return "";
            // readString() drains the whole RX buffer without blocking (ASYNC).
            return serial.readString();
        }
    }
}
