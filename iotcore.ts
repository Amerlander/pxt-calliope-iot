/**
 * IoT core: everything between the blocks and the transports.
 *
 * Owns the send buffer, the flush timing, the receive cache, the handler
 * dispatch, the read scope, the device identity and the clock. There are two
 * ways out, and the core picks one on every tick, never because of a block:
 *
 *   WLAN    `iotcore.wlanSender()` is non-null (the program connected WiFi,
 *           wlanclient.ts registered its sender). Points go as frozen batches
 *           through that sender, one request at a time, from a sender fiber.
 *   Campus  otherwise. Points go as `IOT1:` lines (iotcampus.ts) to every open
 *           pipe: RAM mailbox, USB serial, BLE side channel, simulator panel.
 *
 * Fibers (plan §2.3):
 *   core loop   every 100 ms (10 ms while lines wait for the mailbox). Never
 *               blocks: reads the Campus pipes, sends the hello, processes the
 *               answer the sender fiber handed back, starts handler fibers,
 *               decides when to flush.
 *   sender      one short-lived fiber per WLAN request: takes ONE frozen
 *               batch, calls the (blocking) sender, hands the Answer back.
 *               A hanging network therefore never holds the receive side or
 *               the Campus line.
 *   handlers    one fiber per handler invocation, with caps, so a `play tone`
 *               in a handler never stops sending.
 *
 * Tables are parallel arrays of primitives: on the device every object is a
 * heap block, and a point is created on every `send`.
 *
 * NaN-safe comparisons everywhere: "wait" is always written `if (now < t)`,
 * so a NaN deadline means "due", never "never". A NaN interval once made the
 * old device (pxt-grove `setzeTakt`) go silent forever.
 */
namespace iotcore {

    // ---- limits ----------------------------------------------------------

    // 24 points are about two minutes of outage at a 5 s interval: enough to
    // bridge a WiFi rejoin, and small next to a pupil's program.
    const BUFFER_MAX = 24
    // Byte budget per WLAN batch (feed + value literal + addressee + JSON
    // overhead), so one huge text cannot hold back everything behind it. The
    // first point always goes, whatever its size.
    const BATCH_BYTES = 800
    // Last value per (feed, from, to). In a large class with "other devices"
    // the oldest entry goes: RAM is scarcer than completeness is valuable.
    const CACHE_MAX = 32
    // Handler invocations waiting for a fiber; the oldest goes on overflow.
    const PENDING_MAX = 32
    // Handler fibers at once, in total and per handler. A handler that loops
    // forever only ever blocks its own slots.
    const FIBERS_MAX = 6
    const FIBERS_PER_HANDLER = 2

    /** Feed keys longer than this are cut; the server cuts at 32 too (iot.pb.js `feedKey`). */
    export const FEED_MAX = 32
    /** Spelling of a feed (`n`), cut where the server cuts it. */
    export const LABEL_MAX = 64
    /**
     * Text values and log lines. The server keeps 512, but a Campus line must
     * fit the 252-byte mailbox slot whole: 7 + 21 (to) + 1 + 32 (feed) + 1 + 160 = 222.
     */
    export const TEXT_MAX = 160
    const REF_MAX = 120
    const SERVER_MAX = 100

    const INTERVAL_DEFAULT_MS = 5000
    // The server takes about one batch per device per second (900 ms bucket).
    // "Immediately" over WLAN therefore means 1 s. The floor applies in the
    // loop, not when the interval is set: block order is not guaranteed, and a
    // full buffer raises the urgency but never removes the floor.
    const WLAN_FLOOR_MS = 1000
    const BACKOFF_START_MS = 1000
    const BACKOFF_MAX_MS = 30000
    const RETRY_AFTER_MAX_MS = 300000
    // A sender call that has not returned after this long is reported. It is
    // not cancelled: two AT transactions at once would be worse.
    const SENDER_STUCK_MS = 90000
    const TICK_MS = 100
    const TICK_BUSY_MS = 10
    // USB is not ready in the first milliseconds after reset; a hello written
    // there arrived mangled (pxt-grove). Not before this uptime.
    const HELLO_AFTER_MS = 250
    // Clock: later readings only pull when off by more than this, otherwise a
    // seconds display jitters back and forth.
    const CLOCK_JUMP_MS = 2000

    /** Ingest base URL when the program names no server. */
    export const DEFAULT_SERVER = "https://campus-api.calliope.cc/api/iot/v1"

    // What a "from"/"to" field holds when a preset is chosen. The star can
    // never occur in a device id, because ids are numbers (0 dashboard,
    // positive a mini, negative a simulator), so a typed id never collides
    // with a preset.
    export const WHO_ALL = ""
    export const WHO_DASHBOARD = "0"
    export const WHO_OTHERS = "*g"
    export const WHO_ALL_BUT_ME = "*o"
    export const WHO_ME = "*i"

    export const STATE_DISCONNECTED = 0
    export const STATE_CONNECTED = 1
    export const STATE_SENDING = 2
    export const STATE_ERROR = 3

    const KIND_NUMBER = 0
    const KIND_TEXT = 1
    const KIND_SENT = 2

    // ---- state -----------------------------------------------------------

    let started = false
    let ref = ""
    let server = DEFAULT_SERVER
    let intervalMs = INTERVAL_DEFAULT_MS
    let nextFlushMs = 0
    let lastSendMs = 0
    let retryAtMs = 0
    let backoffMs = 0
    let urgent = false
    let state = STATE_DISCONNECTED
    let lastErr = ""
    let wlanSeen = false
    // The announcement is NOT written synchronously at start (USB is not
    // ready yet); the core loop sends it. Also set by a probe and by every
    // change of what the announcement says.
    let helloDue = false

    // Send buffer. Every point gets an id that only ever grows: when an answer
    // arrives, points are removed BY ID. The old code removed by position, and
    // when the buffer overflowed during a request it removed the wrong points
    // and `onSent` reported wrong values.
    let nextId = 1
    let pId: number[] = []
    let pFeed: string[] = []
    let pRaw: string[] = []
    let pTo: string[] = []
    let pTime: number[] = []

    // The one frozen batch (WLAN). A retry resends exactly this batch, with
    // the same seq and the same points, because the server drops a batch whose
    // (boot, seq) it has already written. A rebuilt batch under an old seq
    // would lose its new points; the old points under a new seq would be
    // written twice.
    let fBatch: iotcore.Batch = null
    let fIds: number[] = []
    let fTimes: number[] = []
    let fRaws: string[] = []
    let fLabels: number[] = []
    let inFlight = false
    let inFlightSince = 0
    let answer: iotcore.Answer = null
    let seq = 0
    let bootId = ""
    // 0 = "want one, have none": the first answer is the current state plus a
    // starting point; afterwards only what really changed. Without a cursor
    // every answer restated every feed of every sender, dead simulators
    // included, and `on received` fired with stale values every round.
    let cursor = 0
    // Bumped whenever the cursor is reset (scope or dashboard changed). An
    // answer to a request sent before the reset must not bring the old cursor back.
    let cursorGen = 0
    let launchGen = 0

    // How the child SPELLED a feed whose key is folded. Goes once per Campus
    // host (`IOT1:n:`, reset at every hello) and once per boot over WLAN (`n`).
    let lKey: string[] = []
    let lText: string[] = []
    let lWlan: boolean[] = []
    let lHost: boolean[] = []

    // Cache. The key is the triple, not the feed: two devices writing the same
    // feed are two entries, not one that flips back and forth.
    let cFeed: string[] = []
    let cRaw: string[] = []
    let cNum: number[] = []
    let cIsNum: boolean[] = []
    let cFrom: string[] = []
    let cTo: string[] = []
    let cTime: number[] = []

    // Handlers, one table for all three kinds (the per-handler fiber count
    // needs one index space).
    let hKind: number[] = []
    let hFeed: string[] = []
    let hFrom: string[] = []
    let hNum: ((value: number, from: string, to: string) => void)[] = []
    let hText: ((text: string, from: string, to: string) => void)[] = []
    let hSent: ((feed: string, value: number, to: string) => void)[] = []
    let hRunning: number[] = []
    let running = 0

    // Handler invocations waiting for a fiber.
    let qH: number[] = []
    let qFeed: string[] = []
    let qRaw: string[] = []
    let qNum: number[] = []
    let qFrom: string[] = []
    let qTo: string[] = []

    // The read scope comes from the read blocks; there is no subscribe block.
    // The flags are only ever SET: a program that reads the dashboard in one
    // place and the class in another needs both.
    let wantDashboard = false
    let wantDevices = false

    let simChecked = false
    let sim = false
    let idText = ""
    let nameText = ""

    let clockOffsetMs = 0
    let zoneMin = 0
    let clockKnown = false

    // ---- the engine ------------------------------------------------------

    /** Start the core loop (idempotent). Every entry point calls this. */
    export function start(): void {
        if (started) return
        started = true
        bootId = makeBootId()
        nextFlushMs = control.millis() + intervalMs
        helloDue = true
        control.inBackground(coreLoop)
    }

    function coreLoop(): void {
        while (true) {
            basic.pause(iotcampus.busy() ? TICK_BUSY_MS : TICK_MS)
            tick()
        }
    }

    /** One pass of the core loop. Exported for the Node tests; never blocks. */
    export function tick(): void {
        const campus = !usesWlan()
        if (campus) iotcampus.poll()
        if (helloDue && campus && !(control.millis() < HELLO_AFTER_MS)) {
            helloDue = false
            // A new host has never heard the spellings: each one goes again
            // with the next point of its feed.
            for (let i = 0; i < lHost.length; i++) lHost[i] = false
            iotcampus.hello()
        }
        processAnswer()
        if (inFlight && !(control.millis() - inFlightSince < SENDER_STUCK_MS)) {
            state = STATE_ERROR
            lastErr = "stuck"
        }
        maybeFlush(campus)
        iotcampus.pump()
        dispatch()
    }

    /** True when points go over WLAN: a sender is registered and this is not the simulator. */
    export function usesWlan(): boolean {
        // The simulator has no WiFi module; its transport is the panel, which
        // posts and reads for it. A sender registered there is ignored.
        return iotcore.wlanSender() != null && !isSimulator()
    }

    function maybeFlush(campus: boolean): void {
        const now = control.millis()
        if (campus) {
            // The announcement goes first (it waits for 250 ms uptime): Campus
            // should know who speaks before the first datapoint arrives.
            if (pId.length == 0 || helloDue) return
            if (!urgent && now < nextFlushMs) return
            urgent = false
            nextFlushMs = now + intervalMs
            lastSendMs = now
            flushCampus()
            return
        }
        if (!wlanSeen) {
            // First request as soon as WiFi is there: it brings the clock and
            // the current values.
            wlanSeen = true
            urgent = true
        }
        if (inFlight || answer) return
        if (now < lastSendMs + WLAN_FLOOR_MS) return
        if (now < retryAtMs) return
        if (fBatch) {
            launch(now)
            return
        }
        if (!urgent && now < nextFlushMs) return
        urgent = false
        nextFlushMs = now + Math.max(intervalMs, WLAN_FLOOR_MS)
        // Nothing to send: ask anyway when the program reads something or
        // still needs the clock, because the answer is the only downlink.
        if (pId.length == 0 && !wantDashboard && !wantDevices && clockKnown) return
        freeze()
        launch(now)
    }

    function flushCampus(): void {
        // Campus has no acknowledgement; "connected" comes from the downlink
        // (t:/v:). `onSent` fires when the line really leaves (iotcampus.pump).
        while (pId.length > 0) {
            const feed = pFeed[0]
            const li = lKey.indexOf(feed)
            if (li >= 0 && !lHost[li]) {
                lHost[li] = true
                iotcampus.queueLabel(feed, lText[li])
            }
            iotcampus.queueData(pTo[0], feed, pRaw[0])
            removePoint(0)
        }
    }

    function freeze(): void {
        const b = new iotcore.Batch()
        seq++
        b.seq = seq
        fIds = []
        fTimes = []
        fRaws = []
        fLabels = []
        let bytes = 0
        for (let i = 0; i < pId.length && b.feeds.length < iotcore.BATCH_MAX; i++) {
            const lit = jsonLiteral(pRaw[i])
            const cost = pFeed[i].length + lit.length + pTo[i].length + 24
            if (b.feeds.length > 0 && bytes + cost > BATCH_BYTES) break
            bytes += cost
            b.feeds.push(pFeed[i])
            b.values.push(lit)
            b.tos.push(pTo[i])
            b.ages.push(0)
            fIds.push(pId[i])
            fTimes.push(pTime[i])
            fRaws.push(pRaw[i])
            const li = lKey.indexOf(pFeed[i])
            if (li >= 0 && !lWlan[li] && fLabels.indexOf(li) < 0) {
                fLabels.push(li)
                b.labelKeys.push(lKey[li])
                b.labelTexts.push(lText[li])
            }
        }
        fBatch = b
    }

    function launch(now: number): void {
        const fn = iotcore.wlanSender()
        const b = fBatch
        if (!fn || !b) return
        for (let i = 0; i < fTimes.length; i++) {
            const age = now - fTimes[i]
            b.ages[i] = age > 0 ? age : 0
        }
        const ctx = new iotcore.IngestContext()
        ctx.ref = ref
        ctx.server = server
        ctx.dev = deviceId()
        ctx.scope = scopeCode()
        ctx.since = cursor
        launchGen = cursorGen
        ctx.boot = bootId
        inFlight = true
        inFlightSince = now
        lastSendMs = now
        state = STATE_SENDING
        control.inBackground(function () {
            const a = fn(b, ctx)
            if (a) {
                answer = a
            } else {
                const none = new iotcore.Answer()
                none.error = "no-answer"
                answer = none
            }
            inFlight = false
        })
    }

    function processAnswer(): void {
        const a = answer
        if (!a) return
        answer = null
        if (a.serverSec > 0) setClock(a.serverSec, a.tzoMin)
        if (!a.ok) {
            failed(a.error != "" ? a.error : "error", a.retryAfterMs)
            // An empty poll has nothing to deduplicate: the next attempt may
            // as well carry whatever was queued in the meantime.
            if (fBatch && fBatch.feeds.length == 0) fBatch = null
            return
        }
        const b = fBatch
        fBatch = null
        if (b) {
            for (let i = 0; i < fIds.length; i++) {
                const k = pId.indexOf(fIds[i])
                if (k >= 0) removePoint(k)
            }
            for (let j = 0; j < fLabels.length; j++) lWlan[fLabels[j]] = true
            // Only now, after the server confirmed (incl. `dup`: an earlier
            // attempt was written and its answer got lost). A sound for a value
            // that is about to be resent would be a lie about the connection.
            for (let i = 0; i < b.feeds.length; i++) fireSent(b.feeds[i], fRaws[i], b.tos[i])
        }
        backoffMs = 0
        retryAtMs = 0
        state = STATE_CONNECTED
        lastErr = ""
        for (let r = 0; r < a.dFeeds.length; r++) {
            receive(a.dFeeds[r],
                r < a.dValues.length ? jsonValue(a.dValues[r]) : "",
                r < a.dFroms.length ? a.dFroms[r] : "0",
                r < a.dTos.length ? a.dTos[r] : "")
        }
        // The cursor moves only AFTER every row is in the cache and queued for
        // its handlers: had anything gone wrong, the next request asks again.
        if (a.cur >= 0 && launchGen == cursorGen) cursor = a.cur
        // The server holds more than fit: ask again at the floor, not a whole
        // interval later.
        if (a.more) urgent = true
    }

    function resetCursor(): void {
        cursor = 0
        cursorGen++
    }

    function failed(code: string, retryAfterMs: number): void {
        backoffMs = backoffMs > 0 ? Math.min(backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS
        let wait = backoffMs
        // The server's number wins over our own back-off.
        if (retryAfterMs > 0) wait = Math.min(retryAfterMs, RETRY_AFTER_MAX_MS)
        retryAtMs = control.millis() + wait
        state = STATE_ERROR
        lastErr = code
    }

    function removePoint(k: number): void {
        pId.splice(k, 1)
        pFeed.splice(k, 1)
        pRaw.splice(k, 1)
        pTo.splice(k, 1)
        pTime.splice(k, 1)
    }

    function makeBootId(): string {
        return hex4(Math.randomRange(0, 0xffff)) + hex4(Math.randomRange(0, 0xffff))
            + hex4(control.millis() & 0xffff)
    }

    // ---- configuration ---------------------------------------------------

    /**
     * Which dashboard: slug, `R-…`, `W-…` or `slug:R-…:W-…`. Over Campus it may
     * stay empty; Campus then takes the reference of the open program.
     * @param serverAddress ingest server: host, host:port or full URL
     */
    export function setDashboard(reference: string, serverAddress?: string): void {
        const r = reference ? cut(singleLine(reference).trim(), REF_MAX) : ""
        const s = serverAddress && serverAddress.trim() != "" ? normalizeServer(serverAddress) : server
        // Another dashboard or server: the old cursor means nothing there.
        if (r != ref || s != server) resetCursor()
        ref = r
        server = s
        start()
        helloDue = true
    }

    /**
     * How often the buffer is flushed, in ms; 0 = every value at once (1 s
     * over WLAN). A NaN or omitted value keeps the previous interval.
     */
    export function setInterval(ms: number): void {
        // NOT `ms == undefined`: pxt compares numerically, an omitted argument
        // is NaN and NaN == NaN is false. That check once let NaN through, the
        // next flush time became NaN, and `now >= NaN` is never true: no
        // request ever left. `!(ms >= 0)` is false for NaN and undefined alike.
        if (!(ms >= 0)) return
        start()
        intervalMs = ms
        nextFlushMs = control.millis() + ms
    }

    /** `server` as the ingest base URL: scheme + host + path, no trailing slash. */
    export function normalizeServer(raw: string): string {
        let s = cut(singleLine(raw).trim(), SERVER_MAX)
        while (s.length > 0 && s.charAt(s.length - 1) == "/") s = s.substr(0, s.length - 1)
        if (s == "") return DEFAULT_SERVER
        let scheme = ""
        const p = s.indexOf("://")
        if (p >= 0) {
            scheme = s.substr(0, p + 3).toLowerCase()
            s = s.substr(p + 3, s.length - p - 3)
        }
        const slash = s.indexOf("/")
        const host = slash >= 0 ? s.substr(0, slash) : s
        const path = slash >= 0 ? s.substr(slash, s.length - slash) : "/api/iot/v1"
        if (scheme == "") {
            // Campus' own servers speak https (the ESP32-C3 can); a bare LAN
            // address is a dev server on http.
            const colon = host.indexOf(":")
            const name = (colon >= 0 ? host.substr(0, colon) : host).toLowerCase()
            const tail = "calliope.cc"
            scheme = name.length >= tail.length && name.substr(name.length - tail.length, tail.length) == tail
                ? "https://" : "http://"
        }
        return scheme + host + path
    }

    export function reference(): string { return ref }
    export function serverAddress(): string { return server }

    // ---- sending ---------------------------------------------------------

    /** Queue a number. It goes with the interval, not at once. */
    export function send(feed: string, value: number, to?: string): void {
        queuePoint(feed, numberText(value), to)
    }

    /** Queue a text (one line, at most TEXT_MAX bytes). */
    export function sendText(feed: string, text: string, to?: string): void {
        queuePoint(feed, cut(singleLine(text), TEXT_MAX), to)
    }

    /** Flush at the next tick instead of waiting for the interval (floor and back-off still apply). */
    export function sendNow(): void {
        start()
        urgent = true
    }

    /** A log line (`IOT1:l:`) on every open pipe; over WLAN not on USB serial. */
    export function log(text: string): void {
        start()
        iotcampus.queueLog(cut(singleLine(text), TEXT_MAX))
    }

    /** Points waiting in the send buffer. */
    export function queued(): number {
        return pId.length
    }

    function queuePoint(feed: string, raw: string, to: string): void {
        const key = feedKey(feed)
        if (key == "") return
        start()
        noteLabel(key, feed)
        // On overflow the OLDEST goes: the trend survives, and the current
        // value even more so.
        if (pId.length >= BUFFER_MAX) removePoint(0)
        const toKey = fieldText(to)
        pId.push(nextId)
        nextId++
        pFeed.push(key)
        pRaw.push(raw)
        pTo.push(toKey)
        pTime.push(control.millis())
        // The own value is handled at once, as a full reception and not just
        // in the cache. "All" means all, me included; otherwise it would be
        // the same as "all but me", which the blocks offer separately. It is
        // done LOCALLY because the server never echoes own values (in no
        // scope), so this is the only source for the own sender and nothing
        // can fire twice.
        accept(key, raw, deviceId(), toKey)
        // Interval "immediately": out at the next tick.
        if (intervalMs == 0) urgent = true
        // A full buffer also goes early. The interval is a promise about the
        // delay, the buffer is a memory limit; a value sent early is better
        // than one thrown away (a gap in a chart looks like a broken sensor).
        if (pId.length >= BUFFER_MAX) urgent = true
    }

    function noteLabel(key: string, typed: string): void {
        // Only when spelling and key differ: for "temperatur" there is nothing
        // to tell, and a line that adds nothing is one line too many on a
        // 20-byte link.
        const label = cut(fieldText(typed), LABEL_MAX)
        if (label == "" || label == key) return
        if (lKey.indexOf(key) >= 0) return
        lKey.push(key)
        lText.push(label)
        lWlan.push(false)
        lHost.push(false)
    }

    // ---- receiving -------------------------------------------------------

    /** Runs for every number on `feed` from a sender matching `from` (a WHO_* code or a device id). */
    export function onNumber(feed: string, from: string, handler: (value: number, from: string, to: string) => void): void {
        addHandler(KIND_NUMBER, feedKey(feed), from, handler, null, null)
    }

    /** Runs for every value on `feed` (numbers too, as text) from a sender matching `from`. */
    export function onText(feed: string, from: string, handler: (text: string, from: string, to: string) => void): void {
        addHandler(KIND_TEXT, feedKey(feed), from, null, handler, null)
    }

    /**
     * Runs when a value of this program has really left: over WLAN after the
     * server confirmed it, over Campus when the line was written. "" = every feed.
     */
    export function onSent(feed: string, handler: (feed: string, value: number, to: string) => void): void {
        addHandler(KIND_SENT, feedKey(feed), "", null, null, handler)
    }

    /**
     * Latest number on `feed` from the cache (0 if none). Never touches the network.
     * Without `to` (or "" = all) only values to everyone or to this device count,
     * as for the handlers; an explicit `to` means exactly that addressee (D4).
     */
    export function read(feed: string, from?: string, to?: string): number {
        const i = find(feed, from, to)
        return i >= 0 && cIsNum[i] ? cNum[i] : 0
    }

    /** Latest value on `feed` as text from the cache ("" if none). Same addressee rule as `read`. */
    export function readText(feed: string, from?: string, to?: string): string {
        const i = find(feed, from, to)
        return i >= 0 ? cRaw[i] : ""
    }

    /**
     * A value from outside (Campus line, simulator panel, WLAN downlink).
     * The own id coming back is dropped: the simulator panel reads without
     * `dev` and returns the device's own values, and the own value was
     * already handled when it was sent.
     */
    export function receive(feed: string, raw: string, from: string, to: string): void {
        const key = feedKey(feed)
        if (key == "") return
        const sender = from ? from.trim() : ""
        const fromKey = sender == "" ? WHO_DASHBOARD : sender
        if (fromKey == deviceId()) return
        accept(key, raw ? raw : "", fromKey, fieldText(to))
    }

    function addHandler(kind: number, key: string, from: string,
        hn: (value: number, from: string, to: string) => void,
        ht: (text: string, from: string, to: string) => void,
        hs: (feed: string, value: number, to: string) => void): void {
        start()
        const who = fieldText(from)
        if (kind != KIND_SENT) noteRead(who)
        hKind.push(kind)
        hFeed.push(key)
        hFrom.push(who)
        hNum.push(hn)
        hText.push(ht)
        hSent.push(hs)
        hRunning.push(0)
    }

    function accept(key: string, raw: string, from: string, to: string): void {
        const t = raw.trim()
        const num = parseFloat(t)
        const isNum = t != "" && !isNaN(num)
        let i = -1
        for (let k = 0; k < cFeed.length; k++) {
            if (cFeed[k] == key && cFrom[k] == from && cTo[k] == to) {
                i = k
                break
            }
        }
        if (i < 0) {
            if (cFeed.length >= CACHE_MAX) {
                cFeed.shift(); cRaw.shift(); cNum.shift(); cIsNum.shift()
                cFrom.shift(); cTo.shift(); cTime.shift()
            }
            cFeed.push(key); cRaw.push(raw); cNum.push(isNum ? num : 0); cIsNum.push(isNum)
            cFrom.push(from); cTo.push(to); cTime.push(control.millis())
        } else {
            cRaw[i] = raw
            cNum[i] = isNum ? num : 0
            cIsNum[i] = isNum
            cTime[i] = control.millis()
        }
        // Handlers fire only for values meant for this device: to everyone or
        // to its id. A value addressed to the dashboard or to another mini is
        // in the cache (readable with an explicit "to") but fires nothing here.
        if (!(to == "" || to == deviceId())) return
        for (let h = 0; h < hKind.length; h++) {
            const kind = hKind[h]
            if (kind == KIND_SENT || hFeed[h] != key) continue
            if (kind == KIND_NUMBER && !isNum) continue
            if (!matches(hFrom[h], from)) continue
            enqueue(h, key, raw, isNum ? num : 0, from, to)
        }
        dispatch()
    }

    /** Tells the `onSent` handlers. Called by the core (WLAN) and by iotcampus.pump (Campus). */
    export function fireSent(feed: string, raw: string, to: string): void {
        const n = parseFloat(raw)
        const num = isNaN(n) ? 0 : n
        for (let h = 0; h < hKind.length; h++) {
            if (hKind[h] != KIND_SENT) continue
            if (hFeed[h] != "" && hFeed[h] != feed) continue
            enqueue(h, feed, raw, num, "", to)
        }
        dispatch()
    }

    function enqueue(h: number, feed: string, raw: string, num: number, from: string, to: string): void {
        if (qH.length >= PENDING_MAX) {
            qH.shift(); qFeed.shift(); qRaw.shift(); qNum.shift(); qFrom.shift(); qTo.shift()
        }
        qH.push(h); qFeed.push(feed); qRaw.push(raw); qNum.push(num); qFrom.push(from); qTo.push(to)
    }

    function dispatch(): void {
        let i = 0
        while (i < qH.length && running < FIBERS_MAX) {
            const h = qH[i]
            if (hRunning[h] >= FIBERS_PER_HANDLER) {
                i++
                continue
            }
            const feed = qFeed[i]
            const raw = qRaw[i]
            const num = qNum[i]
            const from = qFrom[i]
            const to = qTo[i]
            qH.splice(i, 1); qFeed.splice(i, 1); qRaw.splice(i, 1)
            qNum.splice(i, 1); qFrom.splice(i, 1); qTo.splice(i, 1)
            running++
            hRunning[h]++
            runHandler(h, feed, raw, num, from, to)
        }
    }

    /**
     * Each invocation in its OWN fiber. A `play tone until done` in a handler
     * that ran in the core fiber stopped sending and the mailbox, and with
     * "all" a value arrives every second: the device looked as if it could
     * only receive. A separate function, so each fiber captures its own values.
     */
    function runHandler(h: number, feed: string, raw: string, num: number, from: string, to: string): void {
        control.inBackground(function () {
            const kind = hKind[h]
            if (kind == KIND_NUMBER) hNum[h](num, from, to)
            else if (kind == KIND_TEXT) hText[h](raw, from, to)
            else hSent[h](feed, num, to)
            running--
            hRunning[h]--
            // A slot is free: the next waiting invocation starts now, not a tick later.
            dispatch()
        })
    }

    function find(feed: string, from: string, to: string): number {
        start()
        const who = fieldText(from)
        noteRead(who)
        const key = feedKey(feed)
        const toWho = fieldText(to)
        // The NEWEST match: without a sender filter several entries match
        // ("other devices"), and the first one in the table is the stalest.
        let hit = -1
        for (let i = 0; i < cFeed.length; i++) {
            if (cFeed[i] != key) continue
            if (!matches(who, cFrom[i])) continue
            if (!addressedTo(toWho, cTo[i])) continue
            if (hit < 0 || cTime[i] >= cTime[hit]) hit = i
        }
        return hit
    }

    /**
     * The addressee rule of `read` (D4). No addressee ("" = all) sees what the
     * handlers see: values to everyone or to this device, never a value the
     * class sent to the dashboard or to another mini. An explicit addressee
     * means exactly that one, and a broadcast has none, so it never matches
     * one ("only this device" = explicitly addressed to me).
     */
    function addressedTo(pattern: string, to: string): boolean {
        if (pattern == WHO_ALL) return to == "" || to == deviceId()
        return to != "" && matches(pattern, to)
    }

    /**
     * Does a "from"/"to" field match this sender/addressee? Empty means "all".
     * The comparison is against the NUMBER, not the name: `from` on the wire
     * is the serial. "Only this device" in a "to" field means EXPLICITLY
     * addressed: a broadcast does not match, or "to me" could not be told
     * apart from "to all".
     */
    function matches(pattern: string, value: string): boolean {
        if (pattern == WHO_ALL) return true
        if (pattern == WHO_ME) return value == deviceId()
        if (pattern == WHO_ALL_BUT_ME) return value != deviceId()
        if (pattern == WHO_OTHERS) return value != deviceId() && value != WHO_DASHBOARD
        return value == pattern
    }

    function noteRead(who: string): void {
        // "Only this device" needs no subscription: own values are in the
        // cache from the moment they are sent.
        if (who == WHO_ME) return
        let d = wantDashboard
        let g = wantDevices
        if (who == WHO_DASHBOARD) d = true
        else if (who == WHO_OTHERS) g = true
        else if (who == WHO_ALL || who == WHO_ALL_BUT_ME) { d = true; g = true }
        else g = true // a typed device id: a device is a device
        if (d == wantDashboard && g == wantDevices) return
        wantDashboard = d
        wantDevices = g
        // The host/server filters by the scope it was told: restate it, and
        // over WLAN start a fresh snapshot for the wider question.
        helloDue = true
        resetCursor()
        if (wlanSeen) urgent = true
    }

    /** Read scope letter as on the wire and in the ingest body: d dashboard, g devices, a all. */
    export function scopeCode(): string {
        if (wantDashboard && wantDevices) return "a"
        if (wantDevices) return "g"
        return "d"
    }

    // ---- plumbing for the transports -------------------------------------

    /** Ask for the announcement again (`IOT1:?` probe). */
    export function requestHello(): void {
        start()
        helloDue = true
    }

    /** Something arrived from a Campus host: it is listening. */
    export function markConnected(): void {
        state = STATE_CONNECTED
        lastErr = ""
    }

    /** `IOT1:e:<code>` from Campus: show it in the status. */
    export function reportError(code: string): void {
        state = STATE_ERROR
        lastErr = code
    }

    // ---- status ----------------------------------------------------------

    /** STATE_DISCONNECTED, STATE_CONNECTED, STATE_SENDING or STATE_ERROR. */
    export function status(): number {
        return state
    }

    /** Short reason of the last failure; "" after a success. */
    export function lastError(): string {
        return lastErr
    }

    // ---- identity --------------------------------------------------------

    /** The simulator reports hardware version "0.0", a real device "1.X", "2" or "3". */
    export function isSimulator(): boolean {
        if (!simChecked) {
            simChecked = true
            sim = control._hardwareVersion() == "0.0"
        }
        return sim
    }

    /**
     * The id this device is filed under: `DEVICEID[1]` as unsigned decimal,
     * negative in the simulator. THE SIGN says "simulator", not a prefix: every
     * id on the wire is a number (0 dashboard, positive a mini, negative a
     * simulator, empty "all"), and a long id costs real bytes on a 20-byte
     * serial buffer.
     */
    export function deviceId(): string {
        if (idText == "") {
            // Unsigned: without `>>> 0` a serial with the top bit set turns negative.
            let n = control.deviceSerialNumber() >>> 0
            // 0 is the dashboard (and Campus folds "-0" onto it).
            if (n == 0) n = 1
            idText = isSimulator() ? "-" + n : "" + n
        }
        return idText
    }

    /**
     * The NAME a class reads off the screen. Display only, never an id: five
     * letters are 3125 names, and in a class of 28 two minis share one with
     * about 11 % probability.
     */
    export function deviceName(): string {
        if (nameText == "") {
            // The firmware's own name (`microbit_friendly_name()`), the one the
            // Campus connection bar shows; rebuilt only if it looks different.
            let name = control.deviceName()
            if (!isCvcvc(name)) name = friendlyName(control.deviceSerialNumber())
            nameText = isSimulator() ? "sim-" + name : name
        }
        return nameText
    }

    const CONSONANTS = "zvgpt"
    const VOWELS = "uoiea"

    /**
     * The same five-step cascade as `microbit_friendly_name()` in codal and DAL
     * (`MicroBitDevice.cpp`) and `friendlyNameFromDeviceId` in the connection
     * widget: five base-5 digits of `NRF_FICR->DEVICEID[1]`, letters set from
     * the back, alternating consonant and vowel.
     */
    export function friendlyName(id: number): string {
        const letters = ["", "", "", "", ""]
        // Unsigned, or the modulo turns negative when the top bit is set.
        let n = id >>> 0
        let ld = 1
        let d = 5
        for (let i = 0; i < 5; i++) {
            const h = Math.floor((n % d) / ld)
            n -= h
            d *= 5
            ld *= 5
            letters[4 - i] = (i % 2 == 0 ? CONSONANTS : VOWELS).charAt(h)
        }
        return letters.join("")
    }

    function isCvcvc(name: string): boolean {
        if (!name || name.length != 5) return false
        for (let i = 0; i < 5; i++) {
            if ((i % 2 == 0 ? CONSONANTS : VOWELS).indexOf(name.charAt(i)) < 0) return false
        }
        return true
    }

    // ---- clock -----------------------------------------------------------

    /**
     * Set the clock from the server (WLAN answer or `IOT1:t:`). The first
     * reading sets it; later ones only jump when off by more than 2 s.
     */
    export function setClock(unixSec: number, tzoMin: number): void {
        if (!(unixSec > 0)) return
        const offset = unixSec * 1000 - control.millis()
        if (!clockKnown || Math.abs(offset - clockOffsetMs) > CLOCK_JUMP_MS) clockOffsetMs = offset
        setZone(tzoMin)
        clockKnown = true
    }

    /** Time zone offset in minutes (`IOT1:z:` may come before or after `t:`). NaN keeps the current one. */
    export function setZone(tzoMin: number): void {
        if (tzoMin - tzoMin == 0) zoneMin = tzoMin
    }

    /** True once the server's time has arrived. Before that a clock shows `--:--` rather than a wrong number. */
    export function timeKnown(): boolean {
        return clockKnown
    }

    /** Unix time in seconds (UTC); 0 while unknown. */
    export function unixSeconds(): number {
        if (!clockKnown) return 0
        return Math.floor((control.millis() + clockOffsetMs) / 1000)
    }

    /** Local time in seconds since 1970 (UTC + zone); 0 while unknown. */
    export function localSeconds(): number {
        if (!clockKnown) return 0
        return unixSeconds() + zoneMin * 60
    }

    export function zoneMinutes(): number {
        return zoneMin
    }

    // ---- text helpers ----------------------------------------------------

    /** A feed name normalised: one line, ':' → '_', trimmed, lowercase, at most FEED_MAX. */
    export function feedKey(s: string): string {
        // Lowercase because "Licht" and "licht" must be one series (the
        // server folds too); a child typing it both ways made no mistake.
        return cut(fieldText(s), FEED_MAX).toLowerCase()
    }

    /** A field of a line: no line break, no colon (it would shift the fields), trimmed. */
    export function fieldText(s: string): string {
        if (!s) return ""
        return singleLine(s).replaceAll(":", "_").trim()
    }

    /** Line breaks would split the line protocol. */
    export function singleLine(s: string): string {
        if (!s) return ""
        return s.replaceAll("\r", " ").replaceAll("\n", " ")
    }

    /** At most `max` bytes; on the device never inside a valid UTF-8 sequence. */
    export function cut(s: string, max: number): string {
        if (s.length <= max) return s
        let end = max
        if (!isSimulator()) {
            // Byte strings on the device. Text from outside is UTF-8, the
            // program's literals are Latin-1 (where 0x80-0xBF are ordinary
            // characters such as '°'), so step back only when a real UTF-8
            // sequence starts within the last 3 bytes and crosses the cut.
            for (let p = end - 1; p >= 0 && p >= end - 3; p--) {
                const c = s.charCodeAt(p)
                if ((c & 0xc0) == 0x80) continue
                const len = c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 1
                if (len > 1 && p + len > end && isCont(s, p + 1, len - 1)) end = p
                break
            }
        }
        return s.substr(0, end)
    }

    /** A number as it travels: NaN and Infinity become 0, three decimals. */
    export function numberText(v: number): string {
        // `v - v == 0` is false for NaN and ±Infinity alike: "Infinity" is
        // neither a JSON number nor a Campus value.
        if (!(v - v == 0)) return "0"
        return "" + Math.roundWithPrecision(v, 3)
    }

    /** Numbers stay numbers, everything else travels as JSON text, as in the ingest hook. */
    export function jsonLiteral(raw: string): string {
        const t = raw.trim()
        const z = parseFloat(t)
        if (t != "" && !isNaN(z) && ("" + z) == t) return t
        return jsonText(raw)
    }

    /**
     * A string as JSON text. Everything outside printable ASCII becomes
     * \uXXXX, so the byte count on the wire equals the character count (raw
     * bytes >= 0x80 in the body become U+FFFD on the server). On the device
     * strings are bytes (utf8=false): text from outside is UTF-8, the
     * program's literals are Latin-1. So a valid UTF-8 sequence is decoded,
     * any other byte is taken as Latin-1, which is also exactly the code
     * unit in the simulator (real UTF-16). Same rule as iotwifi.jsonQuote.
     * Built from runs, not char by char.
     */
    export function jsonText(s: string): string {
        let out = "\""
        let from = 0
        let i = 0
        const n = s.length
        while (i < n) {
            const c = s.charCodeAt(i)
            if (c >= 32 && c < 127 && c != 34 && c != 92) {
                i++
                continue
            }
            if (i > from) out += s.substr(from, i - from)
            let len = 1
            if (c == 34) out += "\\\""
            else if (c == 92) out += "\\\\"
            else {
                let cp = c
                const need = c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : 0
                if (need > 0 && isCont(s, i + 1, need)) {
                    cp = need == 1 ? c & 0x1f : need == 2 ? c & 0x0f : c & 0x07
                    for (let k = 1; k <= need; k++) cp = (cp << 6) | (s.charCodeAt(i + k) & 0x3f)
                    len = need + 1
                }
                if (cp >= 0x10000) {
                    const v = cp - 0x10000
                    out += "\\u" + hex4(0xd800 + (v >> 10)) + "\\u" + hex4(0xdc00 + (v & 0x3ff))
                } else {
                    out += "\\u" + hex4(cp)
                }
            }
            i += len
            from = i
        }
        if (i > from) out += s.substr(from, i - from)
        return out + "\""
    }

    function isCont(s: string, at: number, count: number): boolean {
        if (at + count > s.length) return false
        for (let k = 0; k < count; k++) {
            if ((s.charCodeAt(at + k) & 0xc0) != 0x80) return false
        }
        return true
    }

    /**
     * A JSON literal from the downlink back to the raw text a Campus line
     * would carry: numbers as they are, strings unescaped (UTF-8 bytes on the
     * device, code units in the simulator), null as "".
     */
    export function jsonValue(lit: string): string {
        const s = lit ? lit.trim() : ""
        if (s.length == 0 || s.charAt(0) != "\"") return s == "null" ? "" : s
        const end = s.length > 1 && s.charAt(s.length - 1) == "\"" ? s.length - 1 : s.length
        let out = ""
        let from = 1
        let i = 1
        while (i < end) {
            if (s.charCodeAt(i) != 92 || i + 1 >= end) {
                i++
                continue
            }
            if (i > from) out += s.substr(from, i - from)
            const e = s.charAt(i + 1)
            if (e == "u" && i + 5 < end) {
                let cp = hexValue(s.substr(i + 2, 4))
                i += 6
                if (cp >= 0xd800 && cp < 0xdc00 && i + 5 < end && s.charAt(i) == "\\" && s.charAt(i + 1) == "u") {
                    const lo = hexValue(s.substr(i + 2, 4))
                    if (lo >= 0xdc00 && lo < 0xe000) {
                        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00)
                        i += 6
                    }
                }
                out += codePointText(cp)
            } else {
                out += e == "n" ? "\n" : e == "t" ? "\t" : e == "r" ? "\r" : e
                i += 2
            }
            from = i
        }
        if (end > from) out += s.substr(from, end - from)
        return out
    }

    function codePointText(cp: number): string {
        if (!(cp >= 0)) return ""
        if (cp < 0x80) return String.fromCharCode(cp)
        if (isSimulator()) {
            if (cp < 0x10000) return String.fromCharCode(cp)
            const v = cp - 0x10000
            return String.fromCharCode(0xd800 + (v >> 10)) + String.fromCharCode(0xdc00 + (v & 0x3ff))
        }
        // Device strings are bytes, and the program's own literals are
        // Latin-1 (utf8=false compiles each char as charCode & 0xff): one
        // byte up to U+00FF, so a received "grün" equals the literal "grün";
        // UTF-8 above (no literal can hold those anyway).
        if (cp < 0x100) return String.fromCharCode(cp)
        if (cp < 0x800) return String.fromCharCode(0xc0 | (cp >> 6)) + String.fromCharCode(0x80 | (cp & 0x3f))
        if (cp < 0x10000) return String.fromCharCode(0xe0 | (cp >> 12)) + String.fromCharCode(0x80 | ((cp >> 6) & 0x3f))
            + String.fromCharCode(0x80 | (cp & 0x3f))
        return String.fromCharCode(0xf0 | (cp >> 18)) + String.fromCharCode(0x80 | ((cp >> 12) & 0x3f))
            + String.fromCharCode(0x80 | ((cp >> 6) & 0x3f)) + String.fromCharCode(0x80 | (cp & 0x3f))
    }

    function hexValue(h: string): number {
        let v = 0
        for (let i = 0; i < h.length; i++) {
            const d = "0123456789abcdef".indexOf(h.charAt(i).toLowerCase())
            if (d < 0) return -1
            v = v * 16 + d
        }
        return v
    }

    export function hex4(n: number): string {
        const digits = "0123456789abcdef"
        let out = ""
        for (let i = 3; i >= 0; i--) out += digits.charAt((n >> (i * 4)) & 0xf)
        return out
    }
}
