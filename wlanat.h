// AT engine for ESP-AT WiFi modules, C++ port of wlanat.ts.
//
// This header and wlanat.cpp are pure C++11: no pxt, DAL or CODAL includes,
// so the same code runs on the Calliope mini 2 (DAL), the mini 3 (CODAL) and
// in the host tests (tools/unit/cpp). The board glue lives in wlanport.cpp.
//
// Behaviour follows the TypeScript reference engine wlanat.ts and its Node
// tests (tools/unit): one streaming parser, one transaction at a time, the
// `>` prompt only at line start, exact-match echo skipping, stale finals
// dropped, "busy" -> bounded re-send, URCs never taken as replies, and
// length-framed payloads (+IPD, +CIPRECVDATA, +HTTPC*) passed through
// uninterpreted. Where the C++ differs, the comment says why.
//
// pxt scanner rules for this package's C++ (it scans every .cpp/.h listed in
// pxt.json): no `enum` (it would be turned into a TypeScript enum and a
// forward declaration in the generated pointers.cpp) and no `typedef` at the
// start of a line (copied verbatim into pointers.cpp). Constants are
// `static const int`.

#ifndef IOTAT_WLANAT_H
#define IOTAT_WLANAT_H

#include <stdint.h>

namespace iotat {

// ---- transaction results (same meaning as AT_* in wlanat.ts) ----
static const int R_OK = 0;
static const int R_ERROR = 1;
static const int R_FAIL = 2;
static const int R_TIMEOUT = 3;
// module answered "busy" on every retry, or the engine lock was not free in time
static const int R_BUSY = 4;

// ---- flags of the last result ----
static const int RF_SENT = 1;  // two-phase send: prompt seen, data written
static const int RF_RESET = 2; // module rebooted ("ready") during the transaction
static const int RF_TRUNC = 4; // a line or payload bound was hit, something was dropped

// ---- URC kinds; takeUrc() returns kind | (value << 8) ----
static const int U_NONE = 0;
static const int U_OTHER = 1;     // WIFI GOT IPv6, +STA_*, +DIST_STA_IP, +TIME_UPDATED
static const int U_WIFI = 2;      // WIFI CONNECTED
static const int U_GOT_IP = 3;    // WIFI GOT IP
static const int U_WIFI_LOST = 4; // WIFI DISCONNECT
static const int U_LINK_UP = 5;   // [<id>,]CONNECT            value: link id
static const int U_LINK_DOWN = 6; // [<id>,]CLOSED / CONNECT FAIL
static const int U_READY = 7;     // ready (module reboot)
static const int U_BUSY = 8;      // busy p... / busy s...      value: 'p' or 's'
static const int U_IPD = 9;       // passive +IPD,<len>         value: len

// ---- module families (AT firmware generation, from AT+GMR) ----
static const int FAMILY_UNKNOWN = 0;
static const int FAMILY_ESP8266 = 1; // AT 1.x (ESP8266/ESP8285 NonOS AT)
static const int FAMILY_ESP32 = 2;   // ESP-AT >= 2 (also ESP8266 boards running ESP-AT 2.x)

// ---- capability flags ----
static const int CAP_HTTP = 1;     // AT+HTTPCLIENT / AT+HTTPCPOST
static const int CAP_PASSIVE = 2;  // AT+CIPRECVMODE=1 / AT+CIPRECVDATA
static const int CAP_TLS = 4;      // HTTPS / SSL usable
static const int CAP_SYSSTORE = 8; // AT+SYSSTORE, AT+CWSTATE (else _CUR commands)

struct Caps {
    uint8_t family;
    int8_t major; // -1 if unknown
    int8_t minor; // -1 if unknown
    uint8_t flags;
    char version[16]; // "3.3.0.0"
    char chip[12];    // "ESP32C3"; "" on AT 1.x
    char bin[24];     // "v3.3.0.0(MINI-1)"
};

// Everything the engine needs from its surroundings. The device glue
// implements it on a UART ring and the fiber scheduler, the host tests on a
// scripted fake module and a fake clock. (Not pure virtual: that would need
// __cxa_pure_virtual from the runtime.)
class Host {
  public:
    // Bytes received since the last call, at most `max`; 0 if none. Never blocks.
    virtual int read(uint8_t *, int) { return 0; }
    // Queue bytes for transmission. May block (sleep) until they are accepted.
    virtual void write(const uint8_t *, int) {}
    // Milliseconds, monotonic, wrapping at 2^32.
    virtual uint32_t now() { return 0; }
    // Let other fibers run for about `ms`.
    virtual void sleep(uint32_t) {}
};

class Engine {
  public:
    Engine();
    // The device never destroys its engine; this is for the host tests.
    ~Engine();

    // Allocate the buffers (malloc). The receive buffer for active +IPD data
    // is allocated on first use, because only AT 1.x modules without passive
    // mode need it. Returns false if memory is short.
    //   lineMax    longest line kept (longer ones are cut and flagged)
    //   linesCap   bytes for the info lines of one reply
    //   payloadCap bytes for the length-framed payload of one reply
    //   recvCap    bytes for buffered active socket data
    bool init(Host *host, int lineMax, int linesCap, int payloadCap, int recvCap);

    // Send one AT command (without CRLF) and wait for OK / ERROR / FAIL.
    // `cmd` must stay valid for the whole call. timeoutMs restarts after
    // each "busy" re-send. Returns R_*.
    int command(const char *cmd, int len, int timeoutMs);

    // Two-phase send (AT+CIPSEND, AT+HTTPCPOST): wait for `>` only (the OK
    // before it is not the prompt), then write `data` and wait for SEND OK /
    // SEND FAIL / ERROR while collecting length-framed payload. SEND OK is
    // R_OK, SEND FAIL is R_FAIL. RF_SENT tells whether the data went out.
    int sendWithPrompt(const char *cmd, int len, const uint8_t *data, int dataLen, int timeoutMs);

    bool isBusy() const { return locked; }

    // "AT" until OK: wake-up and resync (also refills a module left in data mode).
    bool sync(int attempts, int perTryMs);
    // ATE0. The parser tolerates echo anyway; this only saves UART time.
    bool disableEcho(int timeoutMs);
    // AT+GMR -> caps (conservative defaults if the query fails).
    const Caps &detect(int timeoutMs);

    // Read what the host has and parse it. True if bytes arrived.
    bool pump();
    // Background tick: pump unless a transaction is pumping already.
    void idle();
    // Pump for `ms` (collect URCs).
    void pumpFor(int ms);
    // Pump until >= minBytes of active socket data are buffered; false on
    // timeout or when the link is known closed first. minBytes < 0 only pumps.
    bool waitRecv(int minBytes, int timeoutMs);
    int recvAvailable() const { return recvLen; }
    // Move up to `max` buffered socket bytes to `out` (NULL discards); max < 0 = all.
    int recvTake(uint8_t *out, int max);
    // Oldest URC as kind | (value << 8); 0 if none.
    uint32_t takeUrc();
    int urcCount() const { return urcN; }

    // Parser entry point (pump() feeds it; tests may feed directly).
    void feed(const uint8_t *p, int n);

    // ---- result of the last transaction, valid until the next one starts ----
    uint8_t resultFlags;
    int lineCount() const { return nLines; }
    // i-th info line (no echo, no URCs, no finals); NULL if out of range.
    const char *line(int i, int *len) const;
    // First info line starting with `prefix`; NULL if none.
    const char *findLine(const char *prefix, int plen, int *len) const;
    const uint8_t *payload() const { return payloadBuf; }
    int payloadLength() const { return payloadLen; }

    // ---- tunables ----
    uint16_t pollMs;      // sleep between pumps inside a transaction
    uint16_t idleMs;      // sleep while waiting for the lock
    uint16_t busyDelayMs; // wait after "busy" before re-sending
    uint8_t busyRetries;  // re-sends after "busy"

    // ---- connection state, driven by URCs only ----
    bool wifiConnected;
    bool wifiGotIp;
    bool linkOpen;       // CONNECT seen, CLOSED not yet
    bool echoOn;         // true after power-up / "ready" until ATE0
    int32_t passivePending; // bytes announced by passive +IPD,<len>, not yet fetched
    Caps caps;

    // ---- diagnosis ----
    uint16_t resets;      // "ready" seen
    uint16_t busyCount;   // "busy ..." seen
    uint16_t staleFinals; // result codes nobody waited for
    uint32_t lost;        // URCs pushed out of the queue + frame bytes dropped

  private:
    int transact(const char *cmd, int len, const uint8_t *data, int dataLen, bool withPrompt,
                 int timeoutMs);
    void writeCmd();
    int scanFrame();
    void frameData(const uint8_t *p, int n);
    void endLine();
    void onLine(const char *s, int n, bool over);
    void onFinal(int code);
    void onUrc(int kind, int value);
    void addLine(const char *s, int n);
    void parseGmr();

    Host *host;

    // parser
    uint8_t *lineBuf;
    uint16_t lineMax;
    uint16_t lineLen;
    int32_t frameLeft;
    uint8_t frameKind;
    bool lineOver;   // current line longer than lineMax: rest is discarded
    bool frameCheck; // current line starts with '+': may become a frame header
    bool skipSpace;  // AT 1.x prompt is "> ": drop that one space

    // transaction
    bool locked;
    bool txActive;
    bool txPrompt;
    bool txBusy;
    bool txReset;
    bool txTrunc;
    uint8_t txPhase;
    uint8_t txFinal;
    uint32_t txBusyAt;
    const char *txCmd;
    int txCmdLen;

    // results
    char *linesBuf; // [len][bytes] per line
    uint16_t linesCap;
    uint16_t linesLen;
    uint8_t nLines;
    uint8_t *payloadBuf;
    int payloadCap;
    int payloadLen;       // bytes stored
    int payloadAnnounced; // bytes announced by the reply frames (kept or not)

    // unsolicited data
    uint8_t *recvBuf; // ring, allocated on first +IPD frame
    int recvCap;
    int recvHead;
    int recvLen;
    uint32_t urcQ[16];
    uint8_t urcHead;
    uint8_t urcN;
};

} // namespace iotat

#endif
