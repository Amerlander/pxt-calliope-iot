// Host tests for the C++ AT engine (wlanat.cpp): the Node scenarios of
// tools/unit/wlanat.test.mjs ported to C++, including the random-split
// property test. Build and run: tools/unit/cpp/run.sh (g++, Linux/WSL/macOS).

#include "fakeesp.h"

#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <sstream>

using namespace iotat;

static int failures = 0, checks = 0;
static std::string currentTest;

#define CHECK(cond)                                                                                \
    do {                                                                                           \
        checks++;                                                                                  \
        if (!(cond)) {                                                                             \
            failures++;                                                                            \
            printf("  FAIL %s:%d [%s] %s\n", __FILE__, __LINE__, currentTest.c_str(), #cond);      \
        }                                                                                          \
    } while (0)
#define CHECK_EQ(a, b)                                                                             \
    do {                                                                                           \
        checks++;                                                                                  \
        auto va = (a);                                                                             \
        auto vb = (b);                                                                             \
        if (!(va == vb)) {                                                                         \
            failures++;                                                                            \
            std::ostringstream os;                                                                 \
            os << va << " != " << vb;                                                              \
            printf("  FAIL %s:%d [%s] %s == %s: %s\n", __FILE__, __LINE__, currentTest.c_str(), #a, \
                   #b, os.str().c_str());                                                          \
        }                                                                                          \
    } while (0)

// Buffer sizes of the mini 3 build unless a test says otherwise.
struct Rig {
    FakeEsp fake;
    Engine at;
    explicit Rig(FakeEsp::Opts o = FakeEsp::Opts(), int lineMax = 256, int linesCap = 1024,
                 int payloadCap = 2048, int recvCap = 2048)
        : fake(o) {
        at.init(&fake, lineMax, linesCap, payloadCap, recvCap);
    }
    uint32_t t() { return fake.clock.t; }
};

static int cmd(Rig &k, const std::string &c, int ms) { return k.at.command(c.data(), (int)c.size(), ms); }
static int send(Rig &k, const std::string &c, const std::string &d, int ms) {
    return k.at.sendWithPrompt(c.data(), (int)c.size(), (const uint8_t *)d.data(), (int)d.size(), ms);
}

static std::vector<std::string> lines(Engine &e) {
    std::vector<std::string> v;
    for (int i = 0; i < e.lineCount(); i++) {
        int n;
        const char *s = e.line(i, &n);
        v.push_back(std::string(s, n));
    }
    return v;
}
static std::string payload(Engine &e) { return std::string((const char *)e.payload(), e.payloadLength()); }
static std::string join(const std::vector<std::string> &v) {
    std::string s;
    for (auto &x : v)
        s += x + "|";
    return s;
}

// Comparable text snapshot of a result (the property test compares these).
static std::string res(Engine &e, int code) {
    std::ostringstream os;
    os << "code=" << code << " flags=" << (int)e.resultFlags << " lines=" << join(lines(e))
       << " payload(" << e.payloadLength() << ")=" << payload(e);
    return os.str();
}

static std::vector<uint32_t> drainUrcs(Engine &e) {
    std::vector<uint32_t> v;
    for (uint32_t u = e.takeUrc(); u != 0; u = e.takeUrc())
        v.push_back(u);
    return v;
}
static uint32_t U(int kind, int value = 0) { return (uint32_t)kind | ((uint32_t)value << 8); }

static std::string state(Engine &e) {
    std::ostringstream os;
    os << "urcs=";
    for (auto u : drainUrcs(e))
        os << (u & 0xff) << ":" << (u >> 8) << ",";
    os << " wifi=" << e.wifiConnected << " ip=" << e.wifiGotIp << " link=" << e.linkOpen
       << " passive=" << e.passivePending << " echo=" << e.echoOn << " resets=" << e.resets;
    return os.str();
}

static const std::string CIPSTART = "AT+CIPSTART=\"TCP\",\"192.168.1.172\",8090";
static std::string HTTPCPOST(size_t n) {
    return "AT+HTTPCPOST=\"http://192.168.1.172:8090/api/iot/v1/ingest\"," + std::to_string(n) +
           ",1,\"Content-Type: application/json\"";
}
static const std::string HEALTH = "AT+HTTPCLIENT=2,0,\"https://campus-api.calliope.cc/api/health\",,,2";

// ---------------------------------------------------------------------------
// Scenarios: each returns a text summary; the property test re-runs them with
// the module output split at random positions and expects identical text.
// Individual tests check the interesting fields through `out`.
// ---------------------------------------------------------------------------

using Out = std::map<std::string, std::string>;
static std::string summary(const Out &o) {
    std::string s;
    for (auto &kv : o)
        s += kv.first + ": " + kv.second + "\n";
    return s;
}

static Out basicCodes(Rig &k) {
    Out o;
    int c = cmd(k, "AT", 500);
    o["ok"] = res(k.at, c);
    c = cmd(k, "AT+HTTPCLIENT=?", 500);
    o["err"] = res(k.at, c);
    uint32_t t0 = k.t();
    c = cmd(k, "AT+NOSUCH", 300);
    o["timeout"] = res(k.at, c);
    o["timeoutTook"] = k.t() - t0 >= 300 ? "yes" : "no";
    o["state"] = state(k.at);
    return o;
}

static Out echoErrorSsid(Rig &k) {
    // Echo is on (fresh module): the echoed line contains ERROR and OK.
    k.fake.on("AT+CWJAP=\"ERROR\",\"OK\"", [](const std::string &, const std::smatch &, FakeEsp &f) {
        f.reply({{800, "+CWJAP:1\r\n\r\nFAIL\r\n"}});
    });
    Out o;
    int c = cmd(k, "AT+CWJAP=\"ERRORNET\",\"pw\"", 5000);
    o["join"] = res(k.at, c);
    o["afterJoin"] = state(k.at);
    c = cmd(k, "AT+CWJAP=\"ERROR\",\"OK\"", 5000);
    o["fail"] = res(k.at, c);
    c = cmd(k, "AT+GMR", 1000);
    o["gmrWithEcho"] = res(k.at, c);
    o["ate0"] = k.at.disableEcho(500) ? "yes" : "no";
    c = cmd(k, "AT+GMR", 1000);
    o["gmr"] = res(k.at, c);
    o["state"] = state(k.at);
    return o;
}

static Out urcInterleaved(Rig &k) {
    k.fake.on("AT+GMR", [](const std::string &, const std::smatch &, FakeEsp &f) {
        f.reply({{2, std::string(GMR_ESP32C3[0]) + "\r\n"},
                 {3, "WIFI DISCONNECT\r\n"},
                 {4, std::string(GMR_ESP32C3[1]) + "\r\n" + GMR_ESP32C3[2] + "\r\n"},
                 {5, "0,CLOSED\r\n"},
                 {6, std::string(GMR_ESP32C3[3]) + "\r\n"},
                 {7, "WIFI CONNECTED\r\nWIFI GOT IP\r\n"},
                 {8, "\r\nOK\r\n"}});
    });
    cmd(k, "ATE0", 500);
    Out o;
    int c = cmd(k, "AT+GMR", 1000);
    o["gmr"] = res(k.at, c);
    o["state"] = state(k.at);
    return o;
}

static Out busyRetry(Rig &k) {
    cmd(k, "ATE0", 500);
    // A long command (e.g. CWJAP) is still running; its OK arrives later.
    k.fake.busyUntil = k.t() + 600;
    k.fake.emit("OK\r\n", 550);
    // Our own answer takes a while, so a wrongly accepted stale OK would end
    // the transaction before it arrives.
    k.fake.on("AT+CWSTATE?", [](const std::string &, const std::smatch &, FakeEsp &f) {
        f.reply({{20, "+CWSTATE:2,\"Werkstatt-WLAN\"\r\n\r\nOK\r\n"}});
    });
    Out o;
    int c = cmd(k, "AT+CWSTATE?", 1000);
    o["st"] = res(k.at, c);
    o["sends"] = std::to_string(k.fake.countLog("AT+CWSTATE?"));
    o["stale"] = std::to_string(k.at.staleFinals);
    o["state"] = state(k.at);
    return o;
}

static Out staleAfterTimeout(Rig &k) {
    cmd(k, "ATE0", 500);
    k.fake.on("AT+SLOW", [](const std::string &, const std::smatch &, FakeEsp &f) {
        f.reply({{500, "+SLOW:1\r\n\r\nOK\r\n"}});
    });
    Out o;
    int c = cmd(k, "AT+SLOW", 100);
    o["slow"] = res(k.at, c);
    c = cmd(k, "AT+CWSTATE?", 2000);
    o["next"] = res(k.at, c);
    // Second case: the late reply sits in the receive buffer while nobody
    // pumps and is still there when the next command goes out.
    k.fake.on("AT+SLOW2", [](const std::string &, const std::smatch &, FakeEsp &f) {
        f.reply({{150, "+SLOW:2\r\n\r\nOK\r\n"}});
    });
    k.fake.on("AT+CWSTATE?", [](const std::string &, const std::smatch &, FakeEsp &f) {
        f.reply({{20, "+CWSTATE:2,\"Werkstatt-WLAN\"\r\n\r\nOK\r\n"}});
    });
    c = cmd(k, "AT+SLOW2", 100);
    o["slow2"] = res(k.at, c);
    k.fake.clock.sleep(100);
    c = cmd(k, "AT+CWSTATE?", 2000);
    o["next2"] = res(k.at, c);
    o["stale"] = std::to_string(k.at.staleFinals);
    o["state"] = state(k.at);
    return o;
}

static Out cipsendActive(Rig &k) {
    cmd(k, "ATE0", 500);
    std::string req = httpRequest(283);
    Out o;
    int c = cmd(k, CIPSTART, 5000);
    o["start"] = res(k.at, c);
    o["linkAfterStart"] = k.at.linkOpen ? "yes" : "no";
    c = send(k, "AT+CIPSEND=283", req, 5000);
    o["send"] = res(k.at, c);
    o["reqIntact"] = (!k.fake.received.empty() && k.fake.received[0] == req) ? "yes" : "no";
    o["gotAll"] = k.at.waitRecv(1223, 3000) ? "yes" : "no";
    std::string data(k.at.recvAvailable(), '\0');
    k.at.recvTake((uint8_t *)&data[0], -1);
    o["dataLen"] = std::to_string(data.size());
    o["dataIntact"] = data == k.fake.response ? "yes" : "no";
    k.at.pumpFor(600);
    o["violations"] = std::to_string(k.fake.violations.size());
    o["state"] = state(k.at);
    return o;
}

static Out cipsendPassive(Rig &k, int bite) {
    k.fake.response = httpResponse(464);
    cmd(k, "ATE0", 500);
    Out o;
    int c = cmd(k, "AT+CIPRECVMODE=1", 500);
    o["mode"] = res(k.at, c);
    c = cmd(k, CIPSTART, 5000);
    o["start"] = res(k.at, c);
    c = send(k, "AT+CIPSEND=283", httpRequest(283), 5000);
    o["send"] = res(k.at, c);
    k.at.pumpFor(100);
    o["pendingAfterNotify"] = std::to_string(k.at.passivePending);
    std::string bites, body;
    int n = 0;
    while (k.at.passivePending > 0 && n++ < 10) {
        c = cmd(k, "AT+CIPRECVDATA=" + std::to_string(bite), 1000);
        bites += std::to_string(c) + "/" + std::to_string(k.at.payloadLength()) + "/" +
                 std::to_string(k.at.lineCount()) + " ";
        body += payload(k.at);
    }
    o["bites"] = bites;
    o["bodyIntact"] = body == k.fake.response ? "yes" : "no";
    k.at.pumpFor(600);
    o["recvBuffered"] = std::to_string(k.at.recvAvailable());
    o["violations"] = std::to_string(k.fake.violations.size());
    o["state"] = state(k.at);
    return o;
}

static Out httpcpost(Rig &k) {
    cmd(k, "ATE0", 500);
    std::string body = "{\"d\":123456,\"p\":[[\"temp\",21.5]],\"boot\":7,\"s\":1}";
    int c = send(k, HTTPCPOST(body.size()), body, 5000);
    Out o;
    o["post"] = res(k.at, c);
    o["bodyIntact"] = (!k.fake.received.empty() && k.fake.received[0] == body) ? "yes" : "no";
    o["violations"] = std::to_string(k.fake.violations.size());
    o["state"] = state(k.at);
    return o;
}

static Out httpclient(Rig &k) {
    cmd(k, "ATE0", 500);
    int c = cmd(k, HEALTH, 5000);
    Out o;
    o["get"] = res(k.at, c);
    o["state"] = state(k.at);
    return o;
}

static Out gmrDetect(Rig &k) {
    cmd(k, "ATE0", 500);
    const Caps &c = k.at.detect(1000);
    Out o;
    std::ostringstream os;
    os << (int)c.family << " " << c.version << " " << (int)c.major << "." << (int)c.minor << " "
       << c.chip << " " << c.bin << " flags=" << (int)c.flags;
    o["caps"] = os.str();
    return o;
}

// ---------------------------------------------------------------------------

#define TEST(name) static void name(); static struct name##_reg { name##_reg() { tests().push_back({#name, name}); } } name##_inst; static void name()
static std::vector<std::pair<std::string, void (*)()>> &tests() {
    static std::vector<std::pair<std::string, void (*)()>> t;
    return t;
}

TEST(ok_error_timeout) {
    Rig k;
    Out s = basicCodes(k);
    CHECK_EQ(s["ok"], std::string("code=0 flags=0 lines= payload(0)="));
    CHECK(s["err"].rfind("code=1 ", 0) == 0);
    CHECK(s["timeout"].rfind("code=3 ", 0) == 0);
    CHECK_EQ(s["timeoutTook"], std::string("yes"));
}

TEST(echo_error_ssid_is_not_a_result) {
    Rig k;
    Out s = echoErrorSsid(k);
    CHECK_EQ(s["join"], std::string("code=0 flags=0 lines= payload(0)="));
    CHECK(s["afterJoin"].find("urcs=4:0,2:0,3:0,") != std::string::npos);
    CHECK(s["afterJoin"].find("ip=1") != std::string::npos);
    CHECK_EQ(s["fail"], std::string("code=2 flags=0 lines=+CWJAP:1| payload(0)="));
    std::string gmrLines = std::string(GMR_ESP32C3[0]) + "|" + GMR_ESP32C3[1] + "|" + GMR_ESP32C3[2] + "|" +
                           GMR_ESP32C3[3] + "|";
    CHECK_EQ(s["gmrWithEcho"], "code=0 flags=0 lines=" + gmrLines + " payload(0)=");
    CHECK_EQ(s["ate0"], std::string("yes"));
    CHECK_EQ(s["gmr"], "code=0 flags=0 lines=" + gmrLines + " payload(0)=");
    CHECK(s["state"].find("echo=0") != std::string::npos);
}

TEST(urc_interleaved_mid_response) {
    Rig k;
    Out s = urcInterleaved(k);
    std::string gmrLines = std::string(GMR_ESP32C3[0]) + "|" + GMR_ESP32C3[1] + "|" + GMR_ESP32C3[2] + "|" +
                           GMR_ESP32C3[3] + "|";
    CHECK_EQ(s["gmr"], "code=0 flags=0 lines=" + gmrLines + " payload(0)=");
    CHECK(s["state"].find("urcs=4:0,6:0,2:0,3:0,") != std::string::npos);
    CHECK(s["state"].find("ip=1 link=0") != std::string::npos);
}

TEST(busy_retry_and_late_ok_is_stale) {
    Rig k;
    Out s = busyRetry(k);
    CHECK_EQ(s["st"], std::string("code=0 flags=0 lines=+CWSTATE:2,\"Werkstatt-WLAN\"| payload(0)="));
    CHECK(std::stoi(s["sends"]) >= 2);
    CHECK(std::stoi(s["stale"]) >= 1);
    CHECK_EQ(k.at.busyCount, (uint16_t)(std::stoi(s["sends"]) - 1));
}

TEST(busy_forever_gives_up) {
    Rig k;
    cmd(k, "ATE0", 500);
    k.at.busyRetries = 3;
    k.fake.busyUntil = k.t() + 1000000000u;
    CHECK_EQ(cmd(k, "AT+CWSTATE?", 1000), R_BUSY);
    CHECK_EQ(k.fake.countLog("AT+CWSTATE?"), (size_t)4);
}

TEST(timed_out_reply_does_not_leak) {
    Rig k;
    Out s = staleAfterTimeout(k);
    CHECK(s["slow"].rfind("code=3 ", 0) == 0);
    CHECK_EQ(s["next"], std::string("code=0 flags=0 lines=+CWSTATE:2,\"Werkstatt-WLAN\"| payload(0)="));
    CHECK(s["slow2"].rfind("code=3 ", 0) == 0);
    CHECK_EQ(s["next2"], std::string("code=0 flags=0 lines=+CWSTATE:2,\"Werkstatt-WLAN\"| payload(0)="));
    CHECK(std::stoi(s["stale"]) >= 2);
}

TEST(cipsend_ok_and_prompt_split_data_after_prompt) {
    FakeEsp::Opts o;
    o.promptGap = 40;
    Rig k(o);
    Out s = cipsendActive(k);
    CHECK_EQ(s["start"], std::string("code=0 flags=0 lines= payload(0)="));
    CHECK_EQ(s["linkAfterStart"], std::string("yes"));
    CHECK_EQ(s["send"], std::string("code=0 flags=1 lines=Recv 283 bytes| payload(0)="));
    CHECK_EQ(s["reqIntact"], std::string("yes"));
    CHECK_EQ(s["violations"], std::string("0"));
}

TEST(cipsend_error_instead_of_prompt_writes_nothing) {
    Rig k;
    cmd(k, "ATE0", 500);
    k.fake.on("AT+CIPSEND=5", [](const std::string &, const std::smatch &, FakeEsp &f) {
        f.reply1("link is not valid\r\n\r\nERROR\r\n");
    });
    size_t before = k.fake.written.size();
    int c = send(k, "AT+CIPSEND=5", "hello", 1000);
    CHECK_EQ(res(k.at, c), std::string("code=1 flags=0 lines=link is not valid| payload(0)="));
    CHECK_EQ(k.fake.written.substr(before), std::string("AT+CIPSEND=5\r\n"));
}

TEST(late_send_ok_does_not_end_plain_command) {
    Rig k;
    cmd(k, "ATE0", 500);
    k.fake.on("AT+CWSTATE?", [](const std::string &, const std::smatch &, FakeEsp &f) {
        f.reply({{2, "SEND OK\r\n"}, {20, "+CWSTATE:2,\"x\"\r\n\r\nOK\r\n"}});
    });
    int c = cmd(k, "AT+CWSTATE?", 1000);
    CHECK_EQ(res(k.at, c), std::string("code=0 flags=0 lines=+CWSTATE:2,\"x\"| payload(0)="));
    CHECK_EQ(k.at.staleFinals, (uint16_t)1);
}

TEST(busy_after_prompt_never_resends) {
    Rig k;
    cmd(k, "ATE0", 500);
    k.fake.on("AT+CIPSEND=5", [](const std::string &, const std::smatch &, FakeEsp &f) {
        FakeEsp *pf = &f;
        f.prompt(5, [pf](const std::string &) {
            pf->reply({{2, "busy s...\r\n"}, {300, "Recv 5 bytes\r\n\r\nSEND OK\r\n"}});
        });
    });
    CHECK_EQ(send(k, "AT+CIPSEND=5", "hello", 2000), R_OK);
    CHECK_EQ(k.fake.countLog("AT+CIPSEND=5"), (size_t)1);
    CHECK_EQ(k.fake.received.size(), (size_t)1);
    CHECK_EQ(k.at.busyCount, (uint16_t)1);
}

TEST(active_ipd_1223_bytes_with_poison_intact) {
    Rig k;
    Out s = cipsendActive(k);
    CHECK_EQ(k.fake.response.size(), (size_t)1223);
    CHECK_EQ(s["gotAll"], std::string("yes"));
    CHECK_EQ(s["dataLen"], std::string("1223"));
    CHECK_EQ(s["dataIntact"], std::string("yes"));
    // Poison inside the payload must not have produced URCs or state changes.
    // (echo=1: the scenario sends ATE0 as a plain command, not disableEcho.)
    CHECK_EQ(s["state"], std::string("urcs=5:0,6:0, wifi=0 ip=0 link=0 passive=0 echo=1 resets=0"));
}

TEST(passive_ipd_464_then_four_bites) {
    Rig k;
    Out s = cipsendPassive(k, 128);
    CHECK_EQ(s["mode"], std::string("code=0 flags=0 lines= payload(0)="));
    CHECK(s["send"].rfind("code=0 flags=1", 0) == 0);
    CHECK_EQ(s["pendingAfterNotify"], std::string("464"));
    CHECK_EQ(s["bites"], std::string("0/128/0 0/128/0 0/128/0 0/80/0 "));
    CHECK_EQ(s["bodyIntact"], std::string("yes"));
    CHECK_EQ(s["recvBuffered"], std::string("0"));
    // Re-announced remaining totals after every partial pull (measured on
    // ESP-AT 3.3.0.0); passivePending must follow them down to 0.
    CHECK(s["state"].find("urcs=5:0,9:464,9:336,9:208,9:80,6:0,") != std::string::npos);
    CHECK(s["state"].find("passive=0") != std::string::npos);
}

TEST(passive_200_byte_bites_as_measured) {
    Rig k;
    Out s = cipsendPassive(k, 200);
    CHECK_EQ(s["bites"], std::string("0/200/0 0/200/0 0/64/0 "));
    CHECK_EQ(s["bodyIntact"], std::string("yes"));
}

TEST(httpcpost_payload_before_send_ok) {
    FakeEsp::Opts o;
    o.promptGap = 15;
    Rig k(o);
    Out s = httpcpost(k);
    CHECK(s["post"].rfind("code=0 flags=1 lines= payload(227)={\"cur\":6131,\"n\":1,\"ok\":1,", 0) == 0);
    CHECK(s["post"].find("\r\nSEND OK\r\n") != std::string::npos);
    CHECK_EQ(s["bodyIntact"], std::string("yes"));
    CHECK_EQ(s["violations"], std::string("0"));
}

TEST(httpclient_length_framed_body) {
    Rig k;
    Out s = httpclient(k);
    CHECK_EQ(s["get"], "code=0 flags=0 lines= payload(51)=" + HEALTH_BODY);
}

TEST(gmr_esp32c3) {
    Rig k;
    Out s = gmrDetect(k);
    CHECK_EQ(s["caps"], std::string("2 3.3.0.0 3.3 ESP32C3 v3.3.0.0(MINI-1) flags=15"));
}

static std::string capsFor(const std::string &gmrText) {
    Rig k;
    cmd(k, "ATE0", 500);
    k.fake.on("AT+GMR", [gmrText](const std::string &, const std::smatch &, FakeEsp &f) { f.reply1(gmrText); });
    const Caps &c = k.at.detect(1000);
    std::ostringstream os;
    os << (int)c.family << " " << c.version << " " << (int)c.major << "." << (int)c.minor << " ["
       << c.chip << "] [" << c.bin << "] flags=" << (int)c.flags;
    return os.str();
}

TEST(gmr_esp8266_at1_and_fallbacks) {
    std::string at1;
    for (auto l : GMR_ESP8266_AT1)
        at1 += std::string(l) + "\r\n";
    CHECK_EQ(capsFor(at1 + "OK\r\n"), std::string("1 1.7.4.0 1.7 [] [1.7.4] flags=0"));
    CHECK_EQ(capsFor("ERROR\r\n"), std::string("0  -1.-1 [] [] flags=0"));
    CHECK_EQ(capsFor("AT version:2.2.0.0(s-b097cdf - ESP8266 - Jun 17 2021 12:57:45)\r\nOK\r\n"),
             std::string("2 2.2.0.0 2.2 [ESP8266] [] flags=11"));
    CHECK_EQ(capsFor("AT version:2.0.0.0(4ecd5b1 - ESP32 - Jan  1 2020 00:00:00)\r\nOK\r\n"),
             std::string("2 2.0.0.0 2.0 [ESP32] [] flags=6"));
}

TEST(ready_during_transaction) {
    Rig k;
    cmd(k, "ATE0", 500);
    cmd(k, "AT+CWJAP=\"a\",\"b\"", 5000);
    k.fake.on("AT+CWSTATE?", [](const std::string &, const std::smatch &, FakeEsp &f) {
        f.o.echo = true;
        f.reply({{50, "\r\nready\r\n"}});
    });
    CHECK_EQ(cmd(k, "AT+CWSTATE?", 2000), R_ERROR);
    CHECK_EQ(k.at.resultFlags & RF_RESET, RF_RESET);
    CHECK_EQ(k.at.resets, (uint16_t)1);
    CHECK(k.at.echoOn);
    CHECK(!k.at.wifiGotIp);
}

TEST(lock_second_caller_gets_busy) {
    Rig k;
    cmd(k, "ATE0", 500);
    int second = -1;
    size_t writtenBefore = 0;
    k.fake.clock.atTime(k.t() + 200, [&]() {
        writtenBefore = k.fake.written.size();
        second = cmd(k, "AT", 50);
    });
    CHECK_EQ(cmd(k, "AT+CWJAP=\"x\",\"y\"", 5000), R_OK);
    CHECK_EQ(second, R_BUSY);
    CHECK_EQ(k.fake.countLog("AT"), (size_t)0);
    CHECK(writtenBefore > 0);
}

TEST(urc_queue_bounded_state_still_updated) {
    Rig k;
    std::string s;
    for (int i = 0; i < 20; i++)
        s += "WIFI CONNECTED\r\nWIFI DISCONNECT\r\n";
    s += "WIFI CONNECTED\r\nWIFI GOT IP\r\n";
    k.at.feed((const uint8_t *)s.data(), (int)s.size());
    CHECK_EQ(k.at.urcCount(), 16);
    CHECK_EQ(k.at.lost, (uint32_t)26);
    CHECK(k.at.wifiGotIp);
}

TEST(parser_bytewise_zero_length_runaway) {
    Rig k;
    std::string stream = std::string("+IPD,0:") + "+IPD,5:a\r\nb>" + "\r\n+IPD,2,3:xyz" +
                         "\r\n+CIPRECVDATA,4:q\r\nq\r\n" + // reply frame nobody waits for: dropped whole
                         "+HTTPCLIENT:x\r\n";              // not a header: a plain (dropped) line
    for (char ch : stream)
        k.at.feed((const uint8_t *)&ch, 1);
    std::string data(k.at.recvAvailable(), '\0');
    k.at.recvTake((uint8_t *)&data[0], -1);
    CHECK_EQ(data, std::string("a\r\nb>xyz"));
    CHECK_EQ(k.at.lost, (uint32_t)4);
    std::string junk(600, 'x');
    k.at.feed((const uint8_t *)junk.data(), (int)junk.size());
    junk = std::string(600, 'y') + "\r\nCLOSED\r\n";
    k.at.feed((const uint8_t *)junk.data(), (int)junk.size());
    auto u = drainUrcs(k.at);
    CHECK_EQ(u.size(), (size_t)1);
    CHECK(!u.empty() && u[0] == U(U_LINK_DOWN));
}

TEST(bounds_oversized_frame_dropped_whole) {
    Rig k(FakeEsp::Opts(), 256, 1024, 40, 8);
    std::string s = "+IPD,5:abcde+IPD,5:fghij+IPD,3:klm";
    k.at.feed((const uint8_t *)s.data(), (int)s.size());
    std::string data(k.at.recvAvailable(), '\0');
    k.at.recvTake((uint8_t *)&data[0], -1);
    CHECK_EQ(data, std::string("abcdeklm"));
    CHECK_EQ(k.at.lost, (uint32_t)5);

    cmd(k, "ATE0", 500);
    int c = cmd(k, HEALTH, 5000);
    CHECK_EQ(c, R_OK);
    CHECK_EQ(k.at.payloadLength(), 0);
    CHECK_EQ(k.at.resultFlags & RF_TRUNC, RF_TRUNC);
}

TEST(recv_take_in_pieces) {
    Rig k;
    std::string s = "+IPD,10:0123456789+IPD,5:abcde";
    k.at.feed((const uint8_t *)s.data(), (int)s.size());
    char buf[16];
    int n = k.at.recvTake((uint8_t *)buf, 4);
    CHECK_EQ(std::string(buf, n), std::string("0123"));
    n = k.at.recvTake((uint8_t *)buf, 8);
    CHECK_EQ(std::string(buf, n), std::string("456789ab"));
    CHECK_EQ(k.at.recvAvailable(), 3);
    n = k.at.recvTake((uint8_t *)buf, -1);
    CHECK_EQ(std::string(buf, n), std::string("cde"));
    CHECK_EQ(k.at.recvTake((uint8_t *)buf, 5), 0);
}

TEST(recv_ring_wraps) {
    Rig k(FakeEsp::Opts(), 256, 1024, 2048, 16);
    std::string all, got;
    for (int r = 0; r < 20; r++) {
        std::string chunk = std::string("ABCDEFGHIJ").substr(0, 3 + r % 7);
        std::string s = "+IPD," + std::to_string(chunk.size()) + ":" + chunk;
        k.at.feed((const uint8_t *)s.data(), (int)s.size());
        all += chunk;
        // keep a small residue so the ring index keeps wrapping without ever
        // hitting the drop-whole bound
        char buf[16];
        int keep = k.at.recvAvailable() > 2 ? k.at.recvAvailable() - 2 : 0;
        int n = k.at.recvTake((uint8_t *)buf, keep);
        got += std::string(buf, n);
    }
    char buf[32];
    int n = k.at.recvTake((uint8_t *)buf, -1);
    got += std::string(buf, n);
    CHECK_EQ(got, all);
    CHECK_EQ(k.at.lost, (uint32_t)0);
}

TEST(cut_echo_tail_is_never_a_final) {
    // lineMax 16: the echo of a long command is cut; its tail spells "OK".
    Rig k(FakeEsp::Opts(), 16, 256, 256, 64);
    std::string c = "AT+CWJAP=\"abcdefgh\",\"OK";
    c = c.substr(0, 16) + "OK"; // 18 chars: the part after the cut is exactly "OK"
    k.fake.on(c, [](const std::string &, const std::smatch &, FakeEsp &f) {
        f.reply({{300, "+CWJAP:1\r\n\r\nFAIL\r\n"}});
    });
    CHECK_EQ(cmd(k, c, 2000), R_FAIL);
}

TEST(cut_line_is_only_ever_an_info_line) {
    // A line longer than lineMax is noise: even if it starts like a URC it
    // must neither trigger a busy re-send nor change state.
    Rig k(FakeEsp::Opts(), 32, 256, 256, 64);
    cmd(k, "ATE0", 500);
    k.fake.on("AT+CWSTATE?", [](const std::string &, const std::smatch &, FakeEsp &f) {
        f.reply1("busy p..." + std::string(100, '.') + "\r\nWIFI DISCONNECT" + std::string(100, '!') +
                 "\r\nOK\r\n");
    });
    k.at.feed((const uint8_t *)"WIFI GOT IP\r\n", 13);
    int c = cmd(k, "AT+CWSTATE?", 1000);
    CHECK_EQ(c, R_OK);
    CHECK_EQ(k.fake.countLog("AT+CWSTATE?"), (size_t)1);
    CHECK_EQ(k.at.lineCount(), 2);
    CHECK_EQ(k.at.resultFlags & RF_TRUNC, RF_TRUNC);
    CHECK(k.at.wifiGotIp);
    CHECK_EQ(k.at.busyCount, (uint16_t)0);
}

TEST(info_lines_after_final_are_not_part_of_the_reply) {
    Rig k;
    cmd(k, "ATE0", 500);
    k.fake.on("AT+CWSTATE?", [](const std::string &, const std::smatch &, FakeEsp &f) {
        f.reply1("+CWSTATE:2,\"x\"\r\n\r\nOK\r\n+LATE:1\r\n");
    });
    int c = cmd(k, "AT+CWSTATE?", 1000);
    CHECK_EQ(res(k.at, c), std::string("code=0 flags=0 lines=+CWSTATE:2,\"x\"| payload(0)="));
}

TEST(uart_timing_model_sanity) {
    FakeEsp::Opts o;
    o.baud = 115200;
    Rig good(o);
    Out s = cipsendActive(good);
    CHECK_EQ(good.fake.overflow, (size_t)0);
    CHECK_EQ(s["dataIntact"], std::string("yes"));

    Rig slow(o);
    cmd(slow, "ATE0", 500);
    cmd(slow, CIPSTART, 5000);
    send(slow, "AT+CIPSEND=283", httpRequest(283), 5000);
    slow.at.pollMs = 100; // what the old drivers did
    slow.at.waitRecv(1223, 3000);
    CHECK(slow.fake.overflow > 0);
}

TEST(property_random_splits_identical) {
    struct Run {
        const char *name;
        std::function<Out(Rig &)> fn;
        int promptGap;
    };
    std::vector<Run> runs = {
        {"basicCodes", basicCodes, 5},
        {"echoErrorSsid", echoErrorSsid, 5},
        {"urcInterleaved", urcInterleaved, 5},
        {"busyRetry", busyRetry, 5},
        {"staleAfterTimeout", staleAfterTimeout, 5},
        {"cipsendActive", cipsendActive, 40},
        {"cipsendPassive", [](Rig &k) { return cipsendPassive(k, 128); }, 5},
        {"httpcpost", httpcpost, 5},
        {"httpclient", httpclient, 5},
        {"gmrDetect", gmrDetect, 5},
    };
    const int SEEDS = 60;
    for (auto &r : runs) {
        FakeEsp::Opts o;
        o.promptGap = r.promptGap;
        std::unique_ptr<Rig> base(new Rig(o));
        std::string baseline = summary(r.fn(*base));
        for (int seed = 1; seed <= SEEDS; seed++) {
            auto rng = std::make_shared<Rng>((uint32_t)(seed * 7919 + strlen(r.name)));
            FakeEsp::Opts os = o;
            os.split = [rng]() { return rng->next(); };
            std::unique_ptr<Rig> k(new Rig(os));
            std::string got = summary(r.fn(*k));
            checks++;
            if (got != baseline) {
                failures++;
                printf("  FAIL property: %s differs with split seed %d\n--- baseline\n%s--- got\n%s", r.name,
                       seed, baseline.c_str(), got.c_str());
                break;
            }
        }
    }
}

int main() {
    for (auto &t : tests()) {
        currentTest = t.first;
        int before = failures;
        t.second();
        printf("%s %s\n", failures == before ? "ok  " : "FAIL", t.first.c_str());
    }
    printf("\n%zu tests, %d checks, %d failures\n", tests().size(), checks, failures);
    return failures ? 1 : 0;
}
