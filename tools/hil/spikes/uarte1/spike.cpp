#include "pxt.h"

// Spike: does NRF52Serial with no explicit device get UARTE1 from the CODAL
// peripheral allocator, next to uBit.serial on UARTE0 (USB)? If so, the WiFi
// module gets its own line and USB serial stays usable.
#if MICROBIT_CODAL
#include "NRF52Serial.h"
#endif

namespace uarte1spike {

#if MICROBIT_CODAL
static NRF52Serial *port = NULL;
#endif

//%
int begin(int tx, int rx, int baud) {
#if MICROBIT_CODAL
    if (port) return 1;
    MicroBitPin *ptx = getPin(tx);
    MicroBitPin *prx = getPin(rx);
    if (!ptx || !prx) return -2;
    // No device argument: the allocator picks the first free UARTE. UARTE0 is
    // taken by uBit.serial, so this must come back as UARTE1 (0x40028000).
    port = new NRF52Serial(*ptx, *prx);
    port->setBaud(baud);
    port->setRxBufferSize(254);
    return 1;
#else
    return -1;
#endif
}

//%
String readAll() {
#if MICROBIT_CODAL
    if (!port) return mkString("", 0);
    uint8_t buf[254];
    int n = port->read(buf, sizeof(buf), ASYNC);
    if (n <= 0) return mkString("", 0);
    return mkString((const char *)buf, n);
#else
    return mkString("", 0);
#endif
}

//%
void writeStr(String s) {
#if MICROBIT_CODAL
    if (!port || !s) return;
    port->send((uint8_t *)s->getUTF8Data(), s->getUTF8Size(), SYNC_SPINWAIT);
#endif
}

//%
int instance() {
#if MICROBIT_CODAL
    // Which UARTEs are enabled right now: bit 0 = UARTE0 (USB), bit 1 = UARTE1.
    return (NRF_UARTE0->ENABLE ? 1 : 0) | (NRF_UARTE1->ENABLE ? 2 : 0);
#else
    return 0;
#endif
}

} // namespace uarte1spike
