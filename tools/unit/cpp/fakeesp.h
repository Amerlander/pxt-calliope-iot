// Scripted fake ESP-AT module + fake clock for the C++ engine host tests.
// A port of tools/unit/fakeesp.mjs (the JS fake used for the TS engine), so
// both engines are tested against the same module behaviour:
//   - outputs captured from a real ESP32-C3 (ESP-AT 3.3.0.0) on 2026-09-29,
//   - echo until ATE0 (echoed as "<cmd>\r\r\n"),
//   - "busy p..." while a previous command is still being processed,
//   - data mode after the `>` prompt (the next N written bytes are payload),
//   - optional random splitting of the output stream (property tests),
//   - optional UART timing into a 254-byte RX buffer that overflows.
// Host-only code: STL is fine here, unlike in the engine.

#pragma once

#include "../../../wlanat.h"

#include <algorithm>
#include <cstdint>
#include <functional>
#include <regex>
#include <string>
#include <vector>

struct Clock {
    uint32_t t = 0;
    struct Hook {
        uint32_t at;
        std::function<void()> fn;
        bool done;
    };
    std::vector<Hook> hooks;
    void sleep(uint32_t ms) {
        t += ms;
        for (size_t i = 0; i < hooks.size(); i++) {
            if (!hooks[i].done && t >= hooks[i].at) {
                hooks[i].done = true;
                auto fn = hooks[i].fn; // copy: fn may add hooks
                fn();
            }
        }
    }
    // Run fn once, from inside the first sleep() that reaches `at` (a simulated other fiber).
    void atTime(uint32_t at, std::function<void()> fn) { hooks.push_back({at, fn, false}); }
};

// Deterministic PRNG (mulberry32), same as the JS tests.
struct Rng {
    uint32_t a;
    explicit Rng(uint32_t seed) : a(seed) {}
    double next() {
        a += 0x6d2b79f5u;
        uint32_t t = a;
        t = (t ^ (t >> 15)) * (t | 1u);
        t ^= t + (t ^ (t >> 7)) * (t | 61u);
        return (double)(t ^ (t >> 14)) / 4294967296.0;
    }
};

static const char *GMR_ESP32C3[] = {
    "AT version:3.3.0.0(3b13d04 - ESP32C3 - May  8 2024 08:21:54)",
    "SDK version:v5.0.6-dirty",
    "compile time(be332568):May  8 2024 08:51:33",
    "Bin version:v3.3.0.0(MINI-1)",
};

static const char *GMR_ESP8266_AT1[] = {
    "AT version:1.7.4.0(May 11 2020 19:13:04)",
    "SDK version:3.0.4(9532ceb)",
    "compile time:May 27 2020 10:12:17",
    "Bin version(Wroom 02):1.7.4",
};

// The module reported 51 bytes: 50 of JSON plus the server's "\n".
static const std::string HEALTH_BODY = "{\"message\":\"API is healthy.\",\"code\":200,\"data\":{}}\n";

// Text that would break a line-based reader if it leaked out of a frame.
static const std::string POISON =
    "\r\nOK\r\nERROR\r\nFAIL\r\n>\r\n+IPD,3:abc\r\nSEND OK\r\nready\r\nbusy p...\r\nWIFI "
    "DISCONNECT\r\nCLOSED\r\n+CIPRECVDATA:4,xxxx\r\n";

// An HTTP response of exactly `total` bytes with POISON inside the body.
static std::string httpResponse(size_t total) {
    auto head = [](size_t len) {
        return "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
               std::to_string(len) + "\r\nConnection: close\r\n\r\n";
    };
    size_t bodyLen = total - head(0).size();
    for (int i = 0; i < 3; i++)
        bodyLen = total - head(bodyLen).size();
    std::string body = "{\"poison\":\"" + POISON;
    int k = 0;
    while (body.size() < bodyLen - 2)
        body += (char)('a' + (k++ % 26));
    body = body.substr(0, bodyLen - 2) + "\"}";
    return head(bodyLen) + body;
}

// A request of exactly `total` bytes.
static std::string httpRequest(size_t total) {
    std::string r = "POST /api/iot/v1/ingest HTTP/1.1\r\nHost: 192.168.1.172:8090\r\nContent-Type: "
                    "application/json\r\n";
    auto cl = [](size_t n) { return "Content-Length: " + std::to_string(n) + "\r\n"; };
    size_t bodyLen = total - r.size() - cl(0).size() - 2;
    for (int i = 0; i < 3; i++)
        bodyLen = total - r.size() - cl(bodyLen).size() - 2;
    std::string body = "{\"d\":1,\"p\":[";
    while (body.size() < bodyLen - 2)
        body += "1";
    body = body.substr(0, bodyLen - 2) + "]}";
    return r + cl(bodyLen) + "\r\n" + body;
}

// Options of the fake. (Outside the class: GCC rejects member initializers of
// a nested struct used in a default argument of the enclosing class.)
struct FakeOpts {
    std::function<double()> split; // deliver random prefixes of the output
    int baud = 0;                  // 0 = instant, unbounded delivery
    int rxCap = 254;
    bool echo = true;
    int promptGap = 5;
    int recvMode = 0; // 0 active (+IPD with data), 1 passive (+IPD,<len>)
};

class FakeEsp : public iotat::Host {
  public:
    using Opts = FakeOpts;
    using Handler = std::function<void(const std::string &line, const std::smatch &m, FakeEsp &f)>;

    Clock clock;
    Opts o;
    struct Item {
        uint32_t at;
        std::string text;
        bool prompt;
        bool started;
        double start;
        size_t sent;
    };
    std::vector<Item> sched;
    std::string avail;
    double wireFree = 0;
    size_t delivered = 0, readTotal = 0, overflow = 0;
    long promptOffset = -1;
    bool promptSeen = true;

    std::string inbuf, written;
    std::vector<std::string> log;
    uint32_t busyUntil = 0;
    int busyRejected = 0;
    size_t dataLeft = 0;
    std::string dataBuf;
    std::function<void(const std::string &)> onData;
    std::vector<std::string> received;
    std::vector<std::string> violations;
    std::string passiveBuf;
    std::string response = httpResponse(1223);

    struct Rule {
        std::string exact;
        std::regex re;
        bool isRe;
        Handler fn;
    };
    std::vector<Rule> rules;

    explicit FakeEsp(Opts opts = Opts()) : o(opts) { installDefaults(); }

    // -- scripting API --
    void on(const std::string &exact, Handler fn) { rules.push_back({exact, std::regex(), false, fn}); }
    void onRe(const std::string &re, Handler fn) { rules.push_back({"", std::regex(re), true, fn}); }

    uint32_t emit(const std::string &text, uint32_t delay = 1, bool prompt = false) {
        uint32_t at = clock.t + delay;
        size_t i = sched.size();
        while (i > 0 && sched[i - 1].at > at)
            i--;
        sched.insert(sched.begin() + i, Item{at, text, prompt, false, 0, 0});
        return at;
    }

    // Reply steps: (delayMs, text). The module is busy until the last one.
    void reply(std::vector<std::pair<uint32_t, std::string>> steps) {
        uint32_t last = clock.t;
        for (auto &s : steps)
            last = std::max(last, emit(s.second, s.first));
        busyUntil = std::max(busyUntil, last);
    }
    void reply1(const std::string &text) { reply({{1, text}}); }

    // "OK", then the prompt, then take n bytes of data and call fn(data).
    void prompt(size_t n, std::function<void(const std::string &)> fn) {
        emit("OK\r\n\r\n", 1);
        uint32_t at = emit(">", 1 + o.promptGap, true);
        busyUntil = std::max(busyUntil, at);
        dataLeft = n;
        dataBuf.clear();
        promptSeen = false;
        onData = fn;
    }

    size_t countLog(const std::string &l) const { return std::count(log.begin(), log.end(), l); }

    // -- Host --
    uint32_t now() override { return clock.t; }
    void sleep(uint32_t ms) override { clock.sleep(ms); }

    void write(const uint8_t *p, int len) override {
        std::string s((const char *)p, len);
        written += s;
        while (!s.empty()) {
            if (dataLeft > 0) {
                if (!promptSeen)
                    violations.push_back("data written before '>' was read");
                std::string take = s.substr(0, dataLeft);
                dataBuf += take;
                dataLeft -= take.size();
                s = s.substr(take.size());
                if (dataLeft == 0) {
                    auto fn = onData;
                    onData = nullptr;
                    received.push_back(dataBuf);
                    fn(dataBuf);
                }
                continue;
            }
            inbuf += s;
            s.clear();
            size_t i;
            while ((i = inbuf.find("\r\n")) != std::string::npos) {
                std::string line = inbuf.substr(0, i);
                inbuf = inbuf.substr(i + 2);
                command(line);
                if (dataLeft > 0) {
                    s = inbuf; // the rest of this write is payload
                    inbuf.clear();
                    break;
                }
            }
        }
    }

    int read(uint8_t *buf, int max) override {
        deliver();
        if (avail.empty())
            return 0;
        size_t n = avail.size();
        if (o.split) {
            // Half the time tiny pieces (splits headers, CRLF pairs, "SEND OK"),
            // otherwise anywhere.
            double r = o.split();
            n = r < 0.5 ? 1 + (size_t)(o.split() * std::min<size_t>(8, n))
                        : 1 + (size_t)(o.split() * n);
        }
        n = std::min(n, (size_t)max);
        memcpy(buf, avail.data(), n);
        avail = avail.substr(n);
        readTotal += n;
        if (promptOffset >= 0 && readTotal > (size_t)promptOffset)
            promptSeen = true;
        return (int)n;
    }

  private:
    void command(const std::string &line) {
        log.push_back(line);
        if (o.echo)
            emit(line + "\r\r\n", 0);
        if (clock.t < busyUntil) {
            busyRejected++;
            emit("busy p...\r\n", 1);
            return;
        }
        for (size_t i = rules.size(); i-- > 0;) {
            Rule &r = rules[i];
            std::smatch m;
            if (r.isRe ? std::regex_match(line, m, r.re) : line == r.exact) {
                auto fn = r.fn;
                fn(line, m, *this);
                return;
            }
        }
        // unknown command: no answer at all (the engine must time out)
    }

    void arrive(const std::string &text, bool prompt) {
        for (char ch : text) {
            if (o.baud && avail.size() >= (size_t)o.rxCap) {
                overflow++;
                continue;
            }
            if (prompt && ch == '>')
                promptOffset = (long)delivered;
            avail += ch;
            delivered++;
        }
    }

    void deliver() {
        uint32_t now = clock.t;
        if (!o.baud) {
            while (!sched.empty() && sched[0].at <= now) {
                Item it = sched[0];
                sched.erase(sched.begin());
                arrive(it.text, it.prompt);
            }
            return;
        }
        double msPerByte = 10000.0 / o.baud; // 8N1
        while (!sched.empty()) {
            Item &it = sched[0];
            if (!it.started) {
                it.started = true;
                it.start = std::max((double)it.at, wireFree);
                it.sent = 0;
            }
            if (it.start > now)
                break;
            size_t arrived = std::min(it.text.size(), (size_t)((now - it.start) / msPerByte));
            if (arrived > it.sent) {
                arrive(it.text.substr(it.sent, arrived - it.sent), it.prompt);
                it.sent = arrived;
            }
            if (it.sent < it.text.size())
                break;
            wireFree = it.start + it.text.size() * msPerByte;
            sched.erase(sched.begin());
        }
    }

    static std::string lines(const char *const *arr, int n) {
        std::string s;
        for (int i = 0; i < n; i++)
            s += std::string(arr[i]) + "\r\n";
        return s;
    }

    void installDefaults() {
        on("AT", [](const std::string &, const std::smatch &, FakeEsp &f) { f.reply1("OK\r\n"); });
        on("ATE0", [](const std::string &, const std::smatch &, FakeEsp &f) {
            f.o.echo = false;
            f.reply1("OK\r\n");
        });
        on("AT+GMR", [](const std::string &, const std::smatch &, FakeEsp &f) {
            f.reply({{3, lines(GMR_ESP32C3, 4) + "\r\nOK\r\n"}});
        });
        onRe("AT\\+CWJAP=.*", [](const std::string &, const std::smatch &, FakeEsp &f) {
            f.reply({{120, "WIFI DISCONNECT\r\n"},
                     {900, "WIFI CONNECTED\r\n"},
                     {1600, "WIFI GOT IP\r\n"},
                     {1700, "\r\nOK\r\n"}});
        });
        on("AT+CWSTATE?", [](const std::string &, const std::smatch &, FakeEsp &f) {
            f.reply1("+CWSTATE:2,\"Werkstatt-WLAN\"\r\n\r\nOK\r\n");
        });
        onRe("AT\\+CIPRECVMODE=([01])", [](const std::string &, const std::smatch &m, FakeEsp &f) {
            f.o.recvMode = std::stoi(m[1]);
            f.reply1("OK\r\n");
        });
        on("AT+HTTPCLIENT=?", [](const std::string &, const std::smatch &, FakeEsp &f) { f.reply1("ERROR\r\n"); });
        on("AT+HTTPCLIENT=2,0,\"https://campus-api.calliope.cc/api/health\",,,2",
           [](const std::string &, const std::smatch &, FakeEsp &f) {
               f.reply({{1300, "+HTTPCLIENT:" + std::to_string(HEALTH_BODY.size()) + "," +
                                   HEALTH_BODY + "\r\nOK\r\n"}});
           });
        onRe("AT\\+CIPSTART=\"TCP\",\"[^\"]+\",\\d+", [](const std::string &, const std::smatch &, FakeEsp &f) {
            f.reply({{40, "CONNECT\r\n\r\nOK\r\n"}});
        });
        onRe("AT\\+CIPSEND=(\\d+)", [](const std::string &, const std::smatch &m, FakeEsp &f) {
            size_t n = std::stoul(m[1]);
            FakeEsp *pf = &f;
            f.prompt(n, [pf, n](const std::string &) {
                FakeEsp &g = *pf;
                g.reply({{2, "Recv " + std::to_string(n) + " bytes\r\n\r\nSEND OK\r\n"}});
                const std::string &resp = g.response;
                if (g.o.recvMode == 0) {
                    g.emit("\r\n+IPD," + std::to_string(resp.size()) + ":" + resp, 60);
                } else {
                    g.passiveBuf += resp;
                    g.emit("+IPD," + std::to_string(resp.size()) + "\r\n", 60);
                }
                g.emit("CLOSED\r\n", 400);
            });
        });
        onRe("AT\\+CIPRECVDATA=(\\d+)", [](const std::string &, const std::smatch &m, FakeEsp &f) {
            size_t k = std::min<size_t>(std::stoul(m[1]), f.passiveBuf.size());
            std::string bite = f.passiveBuf.substr(0, k);
            f.passiveBuf = f.passiveBuf.substr(k);
            // Measured on ESP-AT 3.3.0.0 (2026-10-08): after a partial pull the
            // module re-announces the remaining total (+IPD,461 -> 261 -> 61).
            size_t rest = f.passiveBuf.size();
            // Sent with the reply (the real module did not answer the next pull
            // with "busy"), so the fake is idle again when the next command comes.
            f.reply({{3, "+CIPRECVDATA:" + std::to_string(k) + "," + bite + "\r\nOK\r\n" +
                             (rest > 0 ? "+IPD," + std::to_string(rest) + "\r\n" : std::string())}});
        });
        onRe("AT\\+HTTPCPOST=\"([^\"]+)\",(\\d+),1,\"Content-Type: application/json\"",
             [](const std::string &, const std::smatch &m, FakeEsp &f) {
                 FakeEsp *pf = &f;
                 f.prompt(std::stoul(m[2]), [pf](const std::string &) {
                     // Raw CRLF + result words inside on purpose: framing, not
                     // content, must end the payload.
                     std::string b = "{\"cur\":6131,\"n\":1,\"ok\":1,\"note\":\"\r\nSEND "
                                     "OK\r\nERROR\r\n>\",\"pad\":\"";
                     while (b.size() < 225)
                         b += "x";
                     b += "\"}";
                     pf->reply({{1200, "+HTTPCPOST:" + std::to_string(b.size()) + "," + b + "\r\n"},
                                {1201, "SEND OK\r\n"}});
                 });
             });
    }
};
