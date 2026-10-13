#include "pxt.h"
#include "wlanat.h"

// Board glue for the AT engine (wlanat.cpp) and the shims TypeScript calls
// (wlanshims.ts).
//
// The port owns the module's UART exclusively (plan §2.1): nothing else in the
// extension reads or writes it.
//   mini 3 (CODAL): its own hardware UART, UARTE1, via NRF52Serial. USB serial
//     (UARTE0) stays free for Campus, logs and user programs. Proven on
//     hardware (docs/measurement-uarte1.md).
//   mini 2 (DAL): the only UART, uBit.serial, redirected to the module pins.
//     USB serial is gone while WiFi runs. Same fallback on mini 3 when UARTE1
//     is taken (Jacdac, below).
//
// Receiving: a system-tick component (every 6 ms, interrupt context) moves
// bytes from the runtime's 254-byte serial buffer into a larger ring here, so
// nothing is lost while TypeScript is busy. The engine parses the ring in
// fiber context: inside a transaction, or from the idle callback when nothing
// else runs. When the ring is full the tick stops reading and the bytes wait
// in the runtime buffer (backpressure) instead of being dropped mid-frame.
//
// Transmitting on the own UARTE1 (mini 3) bypasses the codal::Serial TX ring
// and drives EasyDMA directly (dmaWrite). Reason, found in a 60-minute soak
// (USB status lines came out as "cock=" for "clock="): codal::Serial signals
// "my TX ring is empty" with Event(DEVICE_ID_NOTIFY, CODAL_SERIAL_EVT_TX_EMPTY),
// one event shared by ALL Serial instances. A USB writer in SYNC_SLEEP mode
// (every pxt serial.writeString) that waits for room in its own full ring
// wakes on that event and writes the next byte without re-checking for room
// (codal-core Serial::setTxInterrupt), overwriting a byte not yet sent. So any
// ring-based TX on UARTE1 corrupts concurrent USB output, ASYNC or not: the
// event is raised by Serial::dataTransmitted() in the ISR and by
// NRF52Serial::enableInterrupt(TxInterrupt), and dataTransmitted() is not
// virtual, so a subclass cannot silence it. With the ring never used, both
// paths stay quiet: they only fire while the ring holds data. RX is untouched.
//
// Rules of the pxt C++ scanner: every //% function stays outside #if (the
// scanner ignores #if and pointers.cpp references every shim on both boards),
// its signature fits on one line, and no comment line starts with //% or /**.

#if MICROBIT_CODAL
#include "NRF52Serial.h"
#include "peripheral_alloc.h"
#endif

namespace iotwlan {

// Never open the module UART before this uptime. Measured on a mini 3
// (docs/measurement-coldboot.md): opening a UART on C16/C17 about 1.5 s after
// a cold boot (USB re-plugged) panics the board, with or without the module
// attached; at 5 s it never did. Warm boots (after flashing) were always fine,
// so the cause is suspected in the interface-chip/sensor startup, not in the
// module. The exact threshold is still to be bisected (2.5 s / 3.5 s). begin()
// sleeps until this uptime, so a WiFi block at the top of "on start" delays
// only the fiber that calls it.
static const int OPEN_NOT_BEFORE_MS = 5000;

// Memory budgets. Mini 2: the DAL heap is ~20 KB and shared with the pxt GC;
// the receive buffer (active +IPD data, AT 1.x modules only) is allocated on
// first use. Strings handed to TypeScript stay below the ~241-character limit
// of one GC block on a mini 2 with BLE on (docs/research-pxt-variants.md §4.1).
#if MICROBIT_CODAL
#define IOT_RING 2048 // power of two
#define IOT_LINE_MAX 256
#define IOT_LINES 1024
#define IOT_PAYLOAD 2048
#define IOT_RECV 2048
#define IOT_MAX_STR 2048
#define IOT_TX_BUF 254
#else
#define IOT_RING 512 // power of two
#define IOT_LINE_MAX 128
#define IOT_LINES 256
#define IOT_PAYLOAD 512
#define IOT_RECV 512
#define IOT_MAX_STR 200
#define IOT_TX_BUF 64
#endif

// begin() results
#define IOT_PORT_OWN 1      // mini 3: own UART (UARTE1)
#define IOT_PORT_REDIRECT 2 // shared UART redirected to the module pins
#define IOT_ERR_PINS -2
#define IOT_ERR_MEMORY -3
#define IOT_ERR_REDIRECT -4

#if MICROBIT_CODAL
using Uart = codal::Serial;
#else
using Uart = MicroBitSerial;
#endif

static Uart *uart;
static uint8_t *ring;
static volatile uint16_t ringHead; // written by the tick only
static volatile uint16_t ringTail; // written by the fiber side only
static volatile uint32_t ringStalls; // ticks that found the ring full
static bool tickDrain;             // false: the tick slot was not available
static int portKind;
static iotat::Engine *engine;
static uint32_t rxBytes; // bytes handed to the engine since begin (fiber side only)

#if MICROBIT_CODAL
// ---- module TX on the own UARTE1: EasyDMA, no codal::Serial TX ring ----
//
// EasyDMA cannot read flash (string literals live there), so the bytes are
// copied into a RAM buffer first. A 128-byte chunk takes 11 ms at 115200.
#define IOT_DMA_CHUNK 128
static_assert(IOT_DMA_CHUNK * 10000000ull < 0x100000000ull, "wire-time math must fit 32 bits");
// Beyond the computed wire time before the transfer counts as physically
// over: start latency is microseconds, 500 us are almost 6 byte times.
#define IOT_TX_MARGIN_US 500
// Never wait longer than this past the wire time for NRF52Serial's ISR to
// finish its ENDTX/TXSTOPPED handling; normally microseconds.
#define IOT_TX_STUCK_US 100000
static uint8_t *txDma;  // malloc'd only when the own UARTE1 is used
static uint32_t txBaud; // effective baud rate, for the wire time
static bool txLock;     // one writer at a time (writeRaw vs. a transaction)
static bool txLegacy;   // configure(3, 1): old ring path, for the HIL A/B test only
static uint32_t txStuck; // chunks that hit IOT_TX_STUCK_US (stats 11; should stay 0)

// NRF52Serial::setBaudrate maps unsupported rates to 115200 silently; the
// wire-time wait must use the rate actually configured.
static uint32_t effectiveBaud(int baud) {
    switch (baud) {
    case 9600: case 31250: case 38400: case 57600: case 115200: case 230400: case 921600:
    case 1000000:
        return (uint32_t)baud;
    }
    return 115200;
}

// Has NRF52Serial's ISR finished with the last transfer? It stays installed
// (RX needs it) and owns the TX events: on ENDTX it clears the event, finds
// its TX ring empty (never used here) and triggers STOPTX; on TXSTOPPED it
// clears that event. Both handlers leave TXD.PTR/MAXCNT alone and, with the
// ring empty, never call dataTransmitted(), so they raise no TX_EMPTY event.
static bool txHandled() {
    return !nrf_uarte_event_check(NRF_UARTE1, NRF_UARTE_EVENT_ENDTX) &&
           !nrf_uarte_event_check(NRF_UARTE1, NRF_UARTE_EVENT_TXSTOPPED);
}

// Blocking EasyDMA transmit, chunk by chunk. A chunk is done when both hold:
//   - its wire time plus IOT_TX_MARGIN_US has passed. Without hardware flow
//     control the UARTE sends at a fixed rate, so by then ENDTX has fired.
//   - txHandled(): the ISR has processed that ENDTX (and the TXSTOPPED of its
//     STOPTX). This matters when the ISR is delayed, e.g. by the SoftDevice:
//     its late STOPTX must not hit the NEXT transfer, and the buffer must not
//     be refilled while a transfer could still read it.
// Long waits sleep in scheduler ticks (other fibers run); the last 2 ms are
// spun, so the usual command + CRLF pair costs about a millisecond, not two
// 6 ms ticks.
static void dmaWrite(const uint8_t *data, int len) {
    while (txLock)
        fiber_sleep(1);
    txLock = true;
    while (len > 0) {
        int n = len < IOT_DMA_CHUNK ? len : IOT_DMA_CHUNK;
        memcpy(txDma, data, n);
        uint32_t needUs = (uint32_t)n * 10000000u / txBaud + IOT_TX_MARGIN_US; // 8N1
        nrf_uarte_tx_buffer_set(NRF_UARTE1, txDma, n);
        nrf_uarte_task_trigger(NRF_UARTE1, NRF_UARTE_TASK_STARTTX);
        uint32_t start = (uint32_t)system_timer_current_time_us();
        while (true) {
            uint32_t el = (uint32_t)system_timer_current_time_us() - start;
            if (el >= needUs && txHandled())
                break;
            if (el >= needUs + IOT_TX_STUCK_US) {
                txStuck++; // never hang the caller; counted for diagnosis
                break;
            }
            if (el + 2000 < needUs || el > needUs + 2000)
                fiber_sleep(1);
            else
                target_wait_us(50);
        }
        data += n;
        len -= n;
    }
    txLock = false;
}
#endif

// Interrupt context (system tick): runtime serial buffer -> ring. Single
// producer (here), single consumer (DeviceHost::read); 16-bit index stores
// are atomic on Cortex-M. Reads byte by byte: DAL's buffered ASYNC read
// consumes and loses one byte when more is waiting than the buffer holds.
static void drainUart() {
    if (!uart || !ring)
        return;
    while (true) {
        uint16_t h = ringHead;
        uint16_t next = (h + 1) & (IOT_RING - 1);
        if (next == ringTail) {
            ringStalls++;
            return;
        }
        int c = uart->read(MicroBitSerialMode::ASYNC);
        if (c < 0)
            return; // no data, or a user program holds the RX lock
        ring[h] = (uint8_t)c;
        ringHead = next;
    }
}

#if MICROBIT_CODAL
class Drain : public codal::CodalComponent {
  public:
    Drain()
        : codal::CodalComponent(0, DEVICE_COMPONENT_STATUS_SYSTEM_TICK |
                                       DEVICE_COMPONENT_STATUS_IDLE_TICK) {}
    virtual void periodicCallback() override { drainUart(); }
    virtual void idleCallback() override {
        if (engine)
            engine->idle();
    }
};
#else
class Drain : public MicroBitComponent {
  public:
    virtual void systemTick() override { drainUart(); }
    virtual void idleTick() override {
        if (!tickDrain)
            drainUart(); // no tick slot: drain from the idle fiber instead
        if (engine)
            engine->idle();
    }
};
#endif

class DeviceHost : public iotat::Host {
  public:
    virtual int read(uint8_t *buf, int max) override {
        int n = 0;
        uint16_t t = ringTail;
        uint16_t h = ringHead;
        while (n < max && t != h) {
            buf[n++] = ring[t];
            t = (t + 1) & (IOT_RING - 1);
        }
        ringTail = t;
        rxBytes += n;
        return n;
    }

    // Own UARTE1 (mini 3): EasyDMA, see dmaWrite. Shared UART (mini 2, and
    // mini 3 when Jacdac holds UARTE1): ASYNC writes into the runtime's TX
    // ring in pieces, sleeping while it drains. Not SYNC_SLEEP: on CODAL that
    // waits for the shared TX_EMPTY event and can be woken by another port.
    // On the shared UART, USB output is impossible anyway: the pins belong to
    // the module, and a user's serial.write* lands in the AT stream.
    virtual void write(const uint8_t *data, int len) override {
        if (!uart)
            return;
#if MICROBIT_CODAL
        if (portKind == IOT_PORT_OWN && !txLegacy) {
            dmaWrite(data, len);
            return;
        }
#endif
        int off = 0;
        uint32_t start = current_time_ms();
        while (off < len) {
            int r = uart->send((uint8_t *)data + off, len - off, MicroBitSerialMode::ASYNC);
            if (r > 0)
                off += r;
            if (off < len) {
                if ((uint32_t)current_time_ms() - start > 2000u + (uint32_t)len)
                    return; // TX stuck: give up, the transaction will time out
                fiber_sleep(1);
            }
        }
    }

    virtual uint32_t now() override { return (uint32_t)current_time_ms(); }
    virtual void sleep(uint32_t ms) override { fiber_sleep(ms); }
};

static DeviceHost host;

static int clampMs(int ms) {
    return ms > 0 ? ms : 0;
}

// Opens the UART and starts the engine; begin() serialises callers.
static int openPort(int tx, int rx, int baud) {
    int up = current_time_ms();
    if (up < OPEN_NOT_BEFORE_MS)
        fiber_sleep(OPEN_NOT_BEFORE_MS - up);
    MicroBitPin *ptx = getPin(tx);
    MicroBitPin *prx = getPin(rx);
    if (!ptx || !prx)
        return IOT_ERR_PINS;

    if (!ring)
        ring = (uint8_t *)malloc(IOT_RING);
    iotat::Engine *e = new iotat::Engine();
    if (!ring || !e || !e->init(&host, IOT_LINE_MAX, IOT_LINES, IOT_PAYLOAD, IOT_RECV)) {
        delete e;
        return IOT_ERR_MEMORY;
    }

#if MICROBIT_CODAL
    // Jacdac's single-wire serial asks the allocator for "any UARTE" and gets
    // UARTE1; constructing NRF52Serial on a taken UARTE panics (090). Probe
    // the allocator first and fall back to redirecting UARTE0 if it is taken.
    // If Jacdac starts only AFTER this, Jacdac panics 090: programs using
    // Jacdac must start it before WiFi (it normally starts at boot).
    if (codal::allocate_peripheral((void *)NRF_UARTE1)) {
        codal::free_alloc_peri((void *)NRF_UARTE1);
        txDma = (uint8_t *)malloc(IOT_DMA_CHUNK);
        if (!txDma) {
            delete e;
            return IOT_ERR_MEMORY;
        }
        txBaud = effectiveBaud(baud);
        uart = new NRF52Serial(*ptx, *prx, NRF_UARTE1);
        // codal::Serial raises its RX events (RX_FULL, DATA_RECEIVED, ...)
        // under the component id, and NRF52Serial takes DEVICE_ID_SERIAL like
        // uBit.serial: module traffic would look like USB serial events. Our
        // own id keeps the two apart; nothing in the port listens to it.
        uart->id = codal::CodalComponent::generateDynamicID();
        portKind = IOT_PORT_OWN;
    } else {
        uBit.serial.redirect(*ptx, *prx);
        uart = &uBit.serial;
        portKind = IOT_PORT_REDIRECT;
        serialLoggingDisabled = true; // runtime logs must not reach the module
    }
    uart->setBaud(baud);
#else
    // redirect() refuses while another fiber is mid-read or mid-write.
    int r = MICROBIT_SERIAL_IN_USE;
    for (int i = 0; i < 20 && r == MICROBIT_SERIAL_IN_USE; i++) {
        r = uBit.serial.redirect(ptx->name, prx->name);
        if (r == MICROBIT_SERIAL_IN_USE)
            fiber_sleep(10);
    }
    if (r != MICROBIT_OK) {
        delete e;
        return IOT_ERR_REDIRECT;
    }
    uBit.serial.baud(baud);
    uart = &uBit.serial;
    portKind = IOT_PORT_REDIRECT;
    serialLoggingDisabled = true; // runtime logs must not reach the module
#endif
    // Right after redirect: DAL drops received bytes until the buffer exists.
    uart->setRxBufferSize(254);
    // The own UARTE1 never gets a TX ring (see dmaWrite): while it stays
    // uninitialised, dataTransmitted() returns at once even if called.
    if (portKind != IOT_PORT_OWN)
        uart->setTxBufferSize(IOT_TX_BUF);

    engine = e;
    Drain *d = new Drain();
#if !MICROBIT_CODAL
    tickDrain = system_timer_add_component(d) == MICROBIT_OK;
    fiber_add_idle_component(d);
#else
    (void)d; // CodalComponent registers itself
    tickDrain = true;
#endif
    return portKind;
}

// Open the module UART and start the engine. Blocks until uptime >= 5 s (see
// OPEN_NOT_BEFORE_MS). Returns IOT_PORT_OWN / IOT_PORT_REDIRECT, or < 0.
// Idempotent: later calls return the port kind of the first.
//%
int begin(int tx, int rx, int baud) {
    static bool opening = false;
    while (opening) // another fiber is opening it (it may sleep below)
        fiber_sleep(20);
    if (engine)
        return portKind;
    opening = true;
    int r = openPort(tx, rx, baud);
    opening = false;
    return r;
}

// Send an AT command (without CRLF), wait for the final result. Returns
// 0 OK, 1 ERROR, 2 FAIL, 3 TIMEOUT, 4 BUSY; details via lineCount/line/payload.
//%
int command(String cmd, int timeoutMs) {
    if (!engine || !cmd)
        return iotat::R_ERROR;
    registerGCObj(cmd); // the engine keeps pointing at it while fibers switch
    int r = engine->command(cmd->getUTF8Data(), cmd->getUTF8Size(), clampMs(timeoutMs));
    unregisterGCObj(cmd);
    return r;
}

// Two-phase send (AT+CIPSEND / AT+HTTPCPOST): `data` goes out only after the
// '>' prompt. Returns like command(); result flag 1 tells whether it was sent.
//%
int sendData(String cmd, String data, int timeoutMs) {
    if (!engine || !cmd || !data)
        return iotat::R_ERROR;
    registerGCObj(cmd);
    registerGCObj(data);
    int r = engine->sendWithPrompt(cmd->getUTF8Data(), cmd->getUTF8Size(),
                                   (const uint8_t *)data->getUTF8Data(), data->getUTF8Size(),
                                   clampMs(timeoutMs));
    unregisterGCObj(data);
    unregisterGCObj(cmd);
    return r;
}

// Flags of the last result: 1 data sent, 2 module reset, 4 truncated.
//%
int resultFlags() {
    return engine ? engine->resultFlags : 0;
}

// Number of info lines of the last reply.
//%
int lineCount() {
    return engine ? engine->lineCount() : 0;
}

// i-th info line of the last reply ("" if none).
//%
String line(int i) {
    int n = 0;
    const char *s = engine ? engine->line(i, &n) : NULL;
    return mkString(s ? s : "", n);
}

// First info line of the last reply that starts with `prefix` ("" if none).
//%
String findLine(String prefix) {
    int n = 0;
    const char *s = NULL;
    if (engine && prefix)
        s = engine->findLine(prefix->getUTF8Data(), prefix->getUTF8Size(), &n);
    return mkString(s ? s : "", n);
}

// Bytes of length-framed payload of the last reply.
//%
int payloadLength() {
    return engine ? engine->payloadLength() : 0;
}

// Up to `max` payload bytes from `offset` (capped for the mini 2 GC limit).
//%
String payload(int offset, int max) {
    int len = engine ? engine->payloadLength() : 0;
    if (offset < 0 || offset >= len || max <= 0)
        return mkString("", 0);
    int n = len - offset;
    if (n > max)
        n = max;
    if (n > IOT_MAX_STR)
        n = IOT_MAX_STR;
    return mkString((const char *)engine->payload() + offset, n);
}

// Bytes of active socket data (+IPD) buffered.
//%
int recvAvailable() {
    if (!engine)
        return 0;
    engine->pump();
    return engine->recvAvailable();
}

// Take up to `max` bytes of buffered socket data.
//%
String recvTake(int max) {
    if (!engine)
        return mkString("", 0);
    int n = engine->recvAvailable();
    if (n > max)
        n = max;
    if (n > IOT_MAX_STR)
        n = IOT_MAX_STR;
    if (n <= 0)
        return mkString("", 0);
    String s = mkString(NULL, n); // utf8=false: plain byte string, filled in place
    engine->recvTake((uint8_t *)s->getUTF8Data(), n);
    return s;
}

// Pump until >= minBytes of socket data are buffered (false on timeout or
// when the link closed first).
//%
bool waitRecv(int minBytes, int timeoutMs) {
    return engine ? engine->waitRecv(minBytes, clampMs(timeoutMs)) : false;
}

// Oldest queued URC as kind + 256 * value; 0 if none (kinds: wlanat.h U_*).
//%
int takeUrc() {
    if (!engine)
        return 0;
    engine->pump();
    return (int)engine->takeUrc();
}

// Connection state bits: 1 WiFi connected, 2 got IP, 4 link open, 8 echo on,
// 16 port open.
//%
int status() {
    if (!engine)
        return 0;
    engine->pump();
    return (engine->wifiConnected ? 1 : 0) | (engine->wifiGotIp ? 2 : 0) |
           (engine->linkOpen ? 4 : 0) | (engine->echoOn ? 8 : 0) | 16;
}

// AT+GMR -> capabilities: flags (1 HTTP client, 2 passive receive, 4 TLS,
// 8 SYSSTORE) + 256 * family (0 unknown, 1 AT 1.x, 2 ESP-AT >= 2)
// + 65536 * major version (255 = unknown).
//%
int detect(int timeoutMs) {
    if (!engine)
        return 0;
    const iotat::Caps &c = engine->detect(clampMs(timeoutMs));
    return c.flags | (c.family << 8) | ((uint8_t)c.major << 16);
}

// Text from the last detect(): 0 version ("3.3.0.0"), 1 chip ("ESP32C3"),
// 2 bin version.
//%
String moduleInfo(int which) {
    if (!engine)
        return mkString("", 0);
    const iotat::Caps &c = engine->caps;
    const char *s = which == 0 ? c.version : which == 1 ? c.chip : which == 2 ? c.bin : "";
    return mkString(s, -1);
}

// "AT" until OK (wake-up / resync).
//%
bool wake(int attempts, int perTryMs) {
    return engine ? engine->sync(attempts, clampMs(perTryMs)) : false;
}

// ATE0.
//%
bool echoOff(int timeoutMs) {
    return engine ? engine->disableEcho(clampMs(timeoutMs)) : false;
}

// Write bytes to the module as they are: no CRLF, no transaction. For the
// client's recovery of a silent module (filler that completes a send still
// waiting for its data, a lone "+++" that leaves transparent mode). Refused
// while a transaction runs, because the bytes would land inside it.
//%
bool writeRaw(String data) {
    if (!engine || !data || engine->isBusy())
        return false;
    registerGCObj(data);
    host.write((const uint8_t *)data->getUTF8Data(), data->getUTF8Size());
    unregisterGCObj(data);
    return true;
}

// Pump for `ms` (collect URCs).
//%
void pumpFor(int ms) {
    if (engine)
        engine->pumpFor(clampMs(ms));
}

// Numbers for diagnosis: 0 passive bytes pending, 1 module resets, 2 busy
// replies, 3 stale finals, 4 lost (URCs/frame bytes), 5 ring-full ticks,
// 6 port kind, 7 URCs queued, 8 tick drain active (1/0), 9 bytes received
// since begin (wraps; "did the module say anything at all"), 10 TX path
// (1 EasyDMA on the own UARTE1, 2 legacy ring on the own UARTE1, 3 ring of
// the shared UART), 11 DMA chunks that waited past IOT_TX_STUCK_US (0 expected).
//%
int stats(int which) {
    if (!engine)
        return which == 6 ? portKind : 0;
    switch (which) {
    case 0:
        return engine->passivePending;
    case 1:
        return engine->resets;
    case 2:
        return engine->busyCount;
    case 3:
        return engine->staleFinals;
    case 4:
        return (int)engine->lost;
    case 5:
        return (int)ringStalls;
    case 6:
        return portKind;
    case 7:
        return engine->urcCount();
    case 8:
        return tickDrain ? 1 : 0;
    case 9:
        return (int)rxBytes;
    case 10:
#if MICROBIT_CODAL
        if (portKind == IOT_PORT_OWN)
            return txLegacy ? 2 : 1;
#endif
        return 3;
    case 11:
#if MICROBIT_CODAL
        return (int)txStuck;
#endif
        return 0;
    }
    return 0;
}

// Tunables: 0 poll ms inside a transaction, 1 busy retries, 2 busy delay ms,
// 3 = 1: send to the module through the codal::Serial TX ring again, the path
// that corrupts concurrent USB output (see dmaWrite). One-way, own UARTE1
// only; it exists so tools/hil/programs/usb-integrity.ts can show the bug and
// the fix with one build. Never use it in a program.
//%
void configure(int which, int value) {
    if (!engine || value < 0)
        return;
    if (which == 0)
        engine->pollMs = (uint16_t)value;
    else if (which == 1)
        engine->busyRetries = (uint8_t)value;
    else if (which == 2)
        engine->busyDelayMs = (uint16_t)value;
#if MICROBIT_CODAL
    else if (which == 3 && value == 1 && portKind == IOT_PORT_OWN && !txLegacy) {
        while (txLock) // a DMA chunk in flight would clash with ring TX
            fiber_sleep(1);
        uart->setTxBufferSize(IOT_TX_BUF);
        txLegacy = true;
    }
#endif
}

} // namespace iotwlan
