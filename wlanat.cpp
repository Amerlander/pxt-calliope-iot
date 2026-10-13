// AT engine, C++ port of wlanat.ts. Pure C++11; see wlanat.h for the rules.

#include "wlanat.h"

#include <stdlib.h>
#include <string.h>

namespace iotat {

// Frame kinds. A frame is kept whole or dropped whole (decided from its
// announced length), so a bound never leaves a hole inside the data.
static const int FRAME_IPD = 1;   // active socket data -> receive ring
static const int FRAME_REPLY = 2; // +CIPRECVDATA / +HTTPC* -> transaction payload
static const int FRAME_DROP = 3;  // over a bound, or nobody waiting

static const int SCAN_NO = 0;
static const int SCAN_YES = 1;
static const int SCAN_MORE = 2;

static const int MAX_HEADER = 24;      // frame headers are short
static const int MAX_FRAME_LEN = 8192; // ESP-AT never announces more per frame
static const int MAX_LINES = 24;
static const int URC_SLOTS = 16;

static const int PHASE_COMMAND = 0;
static const int PHASE_PROMPT = 1;
static const int PHASE_DATA = 2;

// Final result lines (exact whole-line matches). Index + 1 is the internal
// code; codes >= FIN_SEND_OK only end the data phase of a send.
static const char *const FINALS[] = {"OK", "ERROR", "FAIL", "SEND OK", "SEND FAIL"};
static const uint8_t FINAL_RESULT[] = {0, R_OK, R_ERROR, R_FAIL, R_OK, R_FAIL};
static const int FIN_OK = 1;
static const int FIN_SEND_OK = 4;

// Frame prefixes, matched only at the start of a line. +CIPRECVDATA omits its
// separator: AT 3.x prints "+CIPRECVDATA:<len>," and some AT 1.x builds
// "+CIPRECVDATA,<len>:".
static const char *const FRAME_PREFIXES[] = {"+IPD,", "+CIPRECVDATA", "+HTTPCPOST:",
                                             "+HTTPCLIENT:", "+HTTPCGET:"};
static const int N_FRAME_PREFIXES = 5;

static bool eq(const char *s, int n, const char *lit) {
    int l = (int)strlen(lit);
    return n == l && memcmp(s, lit, l) == 0;
}

static bool startsWith(const char *s, int n, const char *lit) {
    int l = (int)strlen(lit);
    return n >= l && memcmp(s, lit, l) == 0;
}

static int indexOf(const char *s, int n, const char *lit, int from) {
    int l = (int)strlen(lit);
    for (int i = from; i + l <= n; i++)
        if (memcmp(s + i, lit, l) == 0)
            return i;
    return -1;
}

// Decimal digits of s[from, to) -> value; -1 if empty or not all digits.
static int parseUint(const char *s, int from, int to) {
    if (!(from < to))
        return -1;
    int v = 0;
    for (int i = from; i < to; i++) {
        int c = s[i] - '0';
        if (c < 0 || c > 9 || v > 100000000)
            return -1;
        v = v * 10 + c;
    }
    return v;
}

static void copyStr(char *dst, int cap, const char *src, int n) {
    if (n > cap - 1)
        n = cap - 1;
    if (n < 0)
        n = 0;
    memcpy(dst, src, n);
    dst[n] = 0;
}

static int finalCode(const char *s, int n) {
    for (int i = 0; i < 5; i++)
        if (eq(s, n, FINALS[i]))
            return i + 1;
    return 0;
}

// URC kind of a complete line; *value gets the kind's number (see wlanat.h).
static int urcKind(const char *s, int n, int *value) {
    *value = 0;
    if (n == 0)
        return U_NONE;
    char c = s[0];
    if (c == 'W') {
        if (!startsWith(s, n, "WIFI "))
            return U_NONE;
        if (eq(s, n, "WIFI CONNECTED"))
            return U_WIFI;
        if (eq(s, n, "WIFI GOT IP"))
            return U_GOT_IP;
        if (startsWith(s, n, "WIFI DISCONNECT"))
            return U_WIFI_LOST;
        return U_OTHER; // WIFI GOT IPv6 ...
    }
    if (c == 'b') {
        if (!startsWith(s, n, "busy"))
            return U_NONE;
        *value = n > 5 ? (uint8_t)s[5] : 0;
        return U_BUSY;
    }
    if (c == '+') {
        // A colon-less "+IPD,<len>" is the passive notification; active +IPD
        // is framed and never reaches the line handler.
        if (startsWith(s, n, "+IPD,")) {
            // "+IPD,<len>" or "+IPD,<id>,<len>": the length is the last field
            int comma = indexOf(s, n, ",", 5);
            int len = parseUint(s, comma < 0 ? 5 : comma + 1, n);
            *value = len > 0 ? len : 0;
            return U_IPD;
        }
        if (startsWith(s, n, "+STA_") || startsWith(s, n, "+DIST_STA_IP") ||
            startsWith(s, n, "+TIME_UPDATED"))
            return U_OTHER;
        return U_NONE;
    }
    if (eq(s, n, "ready"))
        return U_READY;
    // "CONNECT"/"CLOSED", or "<id>,CONNECT" in multi-connection mode
    const char *t = s;
    int m = n;
    if (n > 2 && s[1] == ',' && s[0] >= '0' && s[0] <= '9') {
        *value = s[0] - '0';
        t = s + 2;
        m = n - 2;
    }
    if (eq(t, m, "CONNECT"))
        return U_LINK_UP;
    if (eq(t, m, "CLOSED") || eq(t, m, "CONNECT FAIL"))
        return U_LINK_DOWN;
    *value = 0;
    return U_NONE;
}

Engine::Engine()
    : resultFlags(0), pollMs(1), idleMs(10), busyDelayMs(250), busyRetries(8),
      wifiConnected(false), wifiGotIp(false), linkOpen(false), echoOn(true), passivePending(0),
      resets(0), busyCount(0), staleFinals(0), lost(0), host(NULL), lineBuf(NULL), lineMax(0),
      lineLen(0), frameLeft(0), frameKind(0), lineOver(false), frameCheck(false),
      skipSpace(false), locked(false), txActive(false), txPrompt(false), txBusy(false),
      txReset(false), txTrunc(false), txPhase(0), txFinal(0), txBusyAt(0), txCmd(NULL),
      txCmdLen(0), linesBuf(NULL), linesCap(0), linesLen(0), nLines(0), payloadBuf(NULL),
      payloadCap(0), payloadLen(0), payloadAnnounced(0), recvBuf(NULL), recvCap(0), recvHead(0),
      recvLen(0), urcHead(0), urcN(0) {
    memset(&caps, 0, sizeof(caps));
    caps.major = -1;
    caps.minor = -1;
}

Engine::~Engine() {
    free(lineBuf);
    free(recvBuf);
}

bool Engine::init(Host *h, int lineMax_, int linesCap_, int payloadCap_, int recvCap_) {
    host = h;
    lineMax = (uint16_t)lineMax_;
    linesCap = (uint16_t)linesCap_;
    payloadCap = payloadCap_;
    recvCap = recvCap_;
    lineBuf = (uint8_t *)malloc(lineMax + linesCap + payloadCap);
    if (!lineBuf)
        return false;
    linesBuf = (char *)lineBuf + lineMax;
    payloadBuf = lineBuf + lineMax + linesCap;
    return true;
}

// ===========================================================================
// Transactions
// ===========================================================================

int Engine::command(const char *cmd, int len, int timeoutMs) {
    return transact(cmd, len, NULL, 0, false, timeoutMs);
}

int Engine::sendWithPrompt(const char *cmd, int len, const uint8_t *data, int dataLen,
                           int timeoutMs) {
    return transact(cmd, len, data, dataLen, true, timeoutMs);
}

bool Engine::sync(int attempts, int perTryMs) {
    for (int i = 0; i < attempts; i++)
        if (command("AT", 2, perTryMs) == R_OK)
            return true;
    return false;
}

bool Engine::disableEcho(int timeoutMs) {
    bool ok = command("ATE0", 4, timeoutMs) == R_OK;
    if (ok)
        echoOn = false;
    return ok;
}

const Caps &Engine::detect(int timeoutMs) {
    if (command("AT+GMR", 6, timeoutMs) != R_OK)
        nLines = 0; // conservative defaults
    parseGmr();
    return caps;
}

void Engine::writeCmd() {
    host->write((const uint8_t *)txCmd, txCmdLen);
    host->write((const uint8_t *)"\r\n", 2);
}

int Engine::transact(const char *cmd, int len, const uint8_t *data, int dataLen, bool withPrompt,
                     int timeoutMs) {
    // Timeouts come from TypeScript; a negative or missing one means "do not
    // wait", never "wait forever".
    uint32_t timeout = timeoutMs > 0 ? (uint32_t)timeoutMs : 0;

    // Fibers are cooperative: test-and-set without a yield in between is
    // atomic. A second caller waits (the owner pumps) and gives up with
    // R_BUSY after its own timeout.
    uint32_t start = host->now();
    while (locked) {
        if (!(host->now() - start < timeout))
            return R_BUSY;
        host->sleep(idleMs);
    }
    locked = true;

    // Whatever is buffered now predates this command (late replies to a
    // timed-out transaction, URCs). Parsing it with no transaction active
    // drops stale finals instead of attributing them to us. pump() reads
    // until the host is empty. (Bytes still on the wire cannot be told
    // apart; the module's "busy" covers most of that.)
    pump();

    txActive = true;
    txCmd = cmd;
    txCmdLen = len;
    txPhase = withPrompt ? PHASE_PROMPT : PHASE_COMMAND;
    txFinal = 0;
    txPrompt = false;
    txBusy = false;
    txReset = false;
    txTrunc = false;
    resultFlags = 0;
    linesLen = 0;
    nLines = 0;
    payloadLen = 0;
    payloadAnnounced = 0;

    writeCmd();
    int attempts = 0;
    int res;
    start = host->now();
    while (true) {
        pump();
        if (txReset) {
            resultFlags |= RF_RESET;
            res = R_ERROR;
            break;
        }
        if (txBusy) {
            // (Never set after the prompt, see onUrc: in data mode a re-sent
            // command would be swallowed as payload.)
            if (!(host->now() - txBusyAt < busyDelayMs)) {
                if (attempts >= busyRetries) {
                    res = R_BUSY;
                    break;
                }
                attempts++;
                // "busy p..." means the module discarded our command. Lines
                // seen so far belong to whatever kept it busy.
                txBusy = false;
                linesLen = 0;
                nLines = 0;
                writeCmd();
                start = host->now();
            }
        } else if (txFinal > 0) {
            res = FINAL_RESULT[txFinal];
            break;
        } else if (txPrompt && txPhase == PHASE_PROMPT) {
            // Switch phase BEFORE writing: finals that show up while the data
            // drains belong to the data phase.
            txPhase = PHASE_DATA;
            if (dataLen > 0)
                host->write(data, dataLen);
            resultFlags |= RF_SENT;
            start = host->now();
            continue;
        }
        if (!(host->now() - start < timeout)) {
            res = R_TIMEOUT;
            break;
        }
        host->sleep(pollMs);
    }
    if (txTrunc)
        resultFlags |= RF_TRUNC;
    txActive = false;
    txCmd = NULL;
    locked = false;
    return res;
}

// ===========================================================================
// Pumping and unsolicited data
// ===========================================================================

bool Engine::pump() {
    uint8_t tmp[64];
    bool any = false;
    while (true) {
        int n = host->read(tmp, sizeof(tmp));
        if (n <= 0)
            break;
        feed(tmp, n);
        any = true;
    }
    return any;
}

void Engine::idle() {
    if (!locked)
        pump();
}

void Engine::pumpFor(int ms) {
    waitRecv(-1, ms);
}

bool Engine::waitRecv(int minBytes, int timeoutMs) {
    uint32_t timeout = timeoutMs > 0 ? (uint32_t)timeoutMs : 0;
    uint32_t start = host->now();
    while (true) {
        pump();
        if (minBytes >= 0) {
            if (recvLen >= minBytes)
                return true;
            // CLOSED comes after the last +IPD in the stream, so everything
            // is parsed by then.
            if (!linkOpen)
                return false;
        }
        if (!(host->now() - start < timeout))
            return false;
        host->sleep(pollMs);
    }
}

int Engine::recvTake(uint8_t *out, int max) {
    if (max < 0 || max > recvLen)
        max = recvLen;
    for (int i = 0; i < max; i++) {
        if (out)
            out[i] = recvBuf[recvHead];
        recvHead = recvHead + 1 == recvCap ? 0 : recvHead + 1;
    }
    recvLen -= max;
    return max;
}

uint32_t Engine::takeUrc() {
    if (urcN == 0)
        return 0;
    uint32_t u = urcQ[urcHead];
    urcHead = (urcHead + 1) % URC_SLOTS;
    urcN--;
    return u;
}

// ===========================================================================
// Streaming parser
// ===========================================================================

void Engine::feed(const uint8_t *p, int n) {
    int i = 0;
    while (i < n) {
        if (frameLeft > 0) {
            // Inside a frame: pass bytes through uninterpreted.
            int take = n - i;
            if (take > frameLeft)
                take = frameLeft;
            frameData(p + i, take);
            i += take;
            frameLeft -= take;
            continue;
        }
        uint8_t c = p[i++];
        if (skipSpace) {
            skipSpace = false;
            if (c == ' ')
                continue;
        }
        if (lineLen == 0 && !lineOver) {
            if (c == '>') {
                // '>' at line start is the send prompt. It is never followed
                // by CRLF, so it cannot wait for a line end.
                skipSpace = true;
                if (txActive && txPhase == PHASE_PROMPT && !txBusy)
                    txPrompt = true;
                continue;
            }
            // '+' may open a length-framed payload; decide while the header
            // streams in, because the payload may contain LFs.
            frameCheck = c == '+';
        }
        if (c == '\n') {
            endLine();
            continue;
        }
        if (lineLen < lineMax)
            lineBuf[lineLen++] = c;
        else
            lineOver = true;
        if (frameCheck) {
            int r = scanFrame();
            if (r == SCAN_YES) {
                lineLen = 0;
                frameCheck = false;
            } else if (r == SCAN_NO) {
                frameCheck = false;
            }
        }
    }
}

// The current line starts with '+': is it (so far) a frame header?
//   +IPD,<len>:  +IPD,<id>,<len>:              active data
//   +IPD,<len>   (CR/LF, no colon)              passive notification: a line
//   +CIPRECVDATA:<len>,   +CIPRECVDATA,<len>:
//   +HTTPCPOST:<len>,  +HTTPCLIENT:<len>,  +HTTPCGET:<len>,
// AT+CIPDINFO=1 headers (remote IP/port) are not supported; keep CIPDINFO off.
int Engine::scanFrame() {
    const char *s = (const char *)lineBuf;
    int n = lineLen;
    int k = 0;
    int i = -1;
    bool more = false;
    for (; k < N_FRAME_PREFIXES; k++) {
        const char *p = FRAME_PREFIXES[k];
        int l = (int)strlen(p);
        int m = n < l ? n : l;
        if (memcmp(s, p, m) != 0)
            continue;
        if (n < l) {
            more = true;
            continue;
        }
        i = l;
        break;
    }
    if (i < 0)
        return more ? SCAN_MORE : SCAN_NO;

    // Numbers separated by ','. ':' ends every header; ',' after a number
    // ends the non-IPD ones (for +IPD it separates <id>,<len>). A separator
    // before any digit is +CIPRECVDATA's own ':' or ','.
    int hs = i;
    int num = -1;
    while (true) {
        if (i - hs > MAX_HEADER)
            return SCAN_NO;
        if (i >= n)
            return SCAN_MORE;
        char c = s[i];
        if (c >= '0' && c <= '9') {
            num = (num < 0 ? 0 : num * 10) + (c - '0');
            if (num > MAX_FRAME_LEN)
                return SCAN_NO;
        } else if (c == ':' || c == ',') {
            if (num < 0) {
                if (i > hs)
                    return SCAN_NO;
            } else if (c == ':' || k > 0) {
                break;
            } else {
                num = -1;
            }
        } else {
            // CR/LF after "+IPD,<len>": the passive notification.
            return SCAN_NO;
        }
        i++;
    }

    frameLeft = num;
    int kind = FRAME_REPLY;
    if (k == 0) {
        kind = recvLen + num > recvCap ? FRAME_DROP : FRAME_IPD;
        if (kind == FRAME_IPD && !recvBuf && num > 0) {
            recvBuf = (uint8_t *)malloc(recvCap);
            if (!recvBuf)
                kind = FRAME_DROP;
        }
    } else {
        if (k == 1) {
            passivePending -= num;
            if (passivePending < 0)
                passivePending = 0;
        }
        if (!txActive || txBusy) {
            // nobody waits, or it answers what made the module busy
            kind = FRAME_DROP;
        } else if (payloadAnnounced + num > payloadCap) {
            kind = FRAME_DROP;
            txTrunc = true;
        } else {
            payloadAnnounced += num;
        }
    }
    if (kind == FRAME_DROP)
        lost += num;
    frameKind = (uint8_t)kind;
    return SCAN_YES;
}

void Engine::frameData(const uint8_t *p, int n) {
    if (frameKind == FRAME_IPD) {
        for (int i = 0; i < n; i++) {
            int t = recvHead + recvLen;
            if (t >= recvCap)
                t -= recvCap;
            recvBuf[t] = p[i];
            recvLen++;
        }
    } else if (frameKind == FRAME_REPLY) {
        memcpy(payloadBuf + payloadLen, p, n);
        payloadLen += n;
    }
}

void Engine::endLine() {
    int n = lineLen;
    while (n > 0 && lineBuf[n - 1] == '\r')
        n--;
    bool over = lineOver;
    lineLen = 0;
    lineOver = false;
    frameCheck = false;
    onLine((const char *)lineBuf, n, over);
}

void Engine::onLine(const char *s, int n, bool over) {
    if (n == 0)
        return;
    // Echo (before ATE0 or after a module reset). Exact match only: an SSID
    // like "ERRORNET" must not look like a result code, and a reply never
    // equals the command text. A cut line (over) matches by prefix.
    if (txActive) {
        if (over ? (txCmdLen > n && memcmp(s, txCmd, n) == 0)
                 : (n == txCmdLen && memcmp(s, txCmd, n) == 0))
            return;
    }
    if (!over) {
        // A line cut at lineMax is never a result code or URC: its tail could
        // spell "OK" by accident.
        int fin = finalCode(s, n);
        if (fin > 0) {
            onFinal(fin);
            return;
        }
        int value;
        int u = urcKind(s, n, &value);
        if (u != U_NONE) {
            onUrc(u, value);
            return;
        }
    }
    // Info line. Nobody asked, it belongs to what made the module busy, or it
    // trails the final (the TS engine kept those; they are never part of the
    // reply): dropped, it carries no state.
    if (!txActive || txBusy || txFinal > 0)
        return;
    if (over)
        txTrunc = true;
    addLine(s, n);
}

void Engine::addLine(const char *s, int n) {
    if (n > 255)
        n = 255;
    if (nLines >= MAX_LINES || linesLen + 1 + n > linesCap) {
        txTrunc = true;
        return;
    }
    linesBuf[linesLen] = (char)n;
    memcpy(linesBuf + linesLen + 1, s, n);
    linesLen += 1 + n;
    nLines++;
}

void Engine::onFinal(int code) {
    // Not ours: nobody waits, a final is already in, or it answers the
    // command that made the module busy (ours was discarded).
    if (!txActive || txBusy || txFinal > 0) {
        staleFinals++;
        return;
    }
    if (code == FIN_OK) {
        // CIPSEND/HTTPCPOST print OK before '>', and a send ends only with
        // SEND OK / SEND FAIL / ERROR.
        if (txPhase != PHASE_COMMAND)
            return;
    } else if (code >= FIN_SEND_OK && txPhase != PHASE_DATA) {
        staleFinals++; // leftover of an earlier send
        return;
    }
    txFinal = (uint8_t)code;
}

void Engine::onUrc(int kind, int value) {
    if (kind == U_WIFI) {
        wifiConnected = true;
    } else if (kind == U_GOT_IP) {
        wifiConnected = true;
        wifiGotIp = true;
    } else if (kind == U_WIFI_LOST) {
        wifiConnected = false;
        wifiGotIp = false;
        linkOpen = false;
    } else if (kind == U_LINK_UP) {
        linkOpen = true;
    } else if (kind == U_LINK_DOWN) {
        linkOpen = false;
    } else if (kind == U_READY) {
        // The module rebooted (brown-out, watchdog, AT+RST): all its state is
        // gone and echo is back on.
        resets++;
        wifiConnected = false;
        wifiGotIp = false;
        linkOpen = false;
        passivePending = 0;
        echoOn = true;
        if (txActive)
            txReset = true;
    } else if (kind == U_BUSY) {
        busyCount++;
        // Once the prompt is seen the module is in data mode; a busy then
        // cannot mean "command discarded", and re-sending the command would
        // be swallowed as payload.
        if (txActive && txFinal == 0 && !txBusy && !txPrompt) {
            txBusy = true;
            txBusyAt = host->now();
        }
    } else if (kind == U_IPD) {
        // The length is what the module holds IN TOTAL, not what just arrived:
        // after each partial CIPRECVDATA it re-announces the rest (measured on
        // ESP-AT 3.3.0.0: +IPD,461 -> +IPD,261 -> +IPD,61). Adding counted the
        // same bytes again and left passivePending at 322 after a full drain.
        passivePending = value;
    }
    if (urcN >= URC_SLOTS) {
        urcHead = (urcHead + 1) % URC_SLOTS;
        urcN--;
        lost++;
    }
    urcQ[(urcHead + urcN) % URC_SLOTS] = (uint32_t)kind | ((uint32_t)value << 8);
    urcN++;
}

// ===========================================================================
// Results
// ===========================================================================

const char *Engine::line(int i, int *len) const {
    int off = 0;
    for (int k = 0; k < nLines; k++) {
        int n = (uint8_t)linesBuf[off];
        if (k == i) {
            *len = n;
            return linesBuf + off + 1;
        }
        off += 1 + n;
    }
    *len = 0;
    return NULL;
}

const char *Engine::findLine(const char *prefix, int plen, int *len) const {
    for (int k = 0; k < nLines; k++) {
        int n;
        const char *s = line(k, &n);
        if (n >= plen && memcmp(s, prefix, plen) == 0) {
            *len = n;
            return s;
        }
    }
    *len = 0;
    return NULL;
}

// AT+GMR info lines -> caps.
//   ESP-AT 3.x: "AT version:3.3.0.0(3b13d04 - ESP32C3 - May  8 2024 08:21:54)"
//   AT 1.x:     "AT version:1.7.4.0(May 11 2020 19:13:04)"
// Defaults are the conservative ones from plan §2.5: only what was measured
// (ESP32-C3, AT 3.3) is on; AT 1.x and unknown firmware get the plain-TCP,
// active-+IPD fallback until a probe proves more.
void Engine::parseGmr() {
    memset(&caps, 0, sizeof(caps));
    caps.major = -1;
    caps.minor = -1;
    int major = -1, minor = -1;
    for (int k = 0; k < nLines; k++) {
        int n;
        const char *l = line(k, &n);
        if (startsWith(l, n, "AT version:")) {
            int end = indexOf(l, n, "(", 11);
            if (end < 0)
                end = n;
            copyStr(caps.version, sizeof(caps.version), l + 11, end - 11);
            int d1 = indexOf(l, end, ".", 11);
            if (d1 < 0)
                d1 = end;
            major = parseUint(l, 11, d1);
            int d2 = indexOf(l, end, ".", d1 + 1);
            if (d2 < 0)
                d2 = end;
            minor = parseUint(l, d1 + 1, d2);
            // ESP-AT >= 2 names the chip: "(<commit> - ESP32C3 - <date>)"
            int e = indexOf(l, n, " - ESP", end);
            if (e > 0) {
                int t = e + 3;
                while (t < n && l[t] != ' ' && l[t] != ')')
                    t++;
                copyStr(caps.chip, sizeof(caps.chip), l + e + 3, t - e - 3);
            }
        } else if (startsWith(l, n, "Bin version")) {
            int colon = indexOf(l, n, ":", 0);
            copyStr(caps.bin, sizeof(caps.bin), l + colon + 1, n - colon - 1);
        }
    }
    caps.major = (int8_t)(major > 127 ? 127 : major);
    caps.minor = (int8_t)(minor > 127 ? 127 : minor);
    if (major >= 2) {
        caps.family = FAMILY_ESP32;
        // HTTPCPOST and SYSSTORE/CWSTATE arrived with ESP-AT 2.1; 2.0 gets the
        // TCP fallback. CIPRECVMODE exists in every ESP-AT 2.x.
        bool atLeast21 = major > 2 || minor >= 1;
        caps.flags = CAP_PASSIVE | (atLeast21 ? CAP_HTTP | CAP_SYSSTORE : 0);
        // TLS on an ESP8266 running ESP-AT 2.x runs out of heap in practice.
        if (!strstr(caps.chip, "ESP8266"))
            caps.flags |= CAP_TLS;
    } else if (major == 1) {
        // Passive receive exists only in late 1.x builds; not measured yet, so
        // stay on active +IPD until a probe (AT+CIPRECVMODE=1 -> OK) says so.
        caps.family = FAMILY_ESP8266;
    }
}

} // namespace iotat
