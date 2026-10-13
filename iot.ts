// The blocks (namespace `iot`). A thin layer: every block calls the core
// (iotcore.ts) or the WLAN client (wlanclient.ts) and adds nothing but the
// translation from block values (enums, omitted optional arguments) to what
// the core expects. Catalogue: docs/blocks.md.
//
// Line comments on purpose: pxt merges a leading doc comment into the doc of
// the first declaration below it, and that doc is the tooltip and the
// translation source.
//
// pxt rules this file follows (each one cost a bug in pxt-grove/iot.ts):
//   - No TypeScript default values on parameters. pxt accepts only numbers,
//     null, true and false as initialisers and fails with "only numbers, null,
//     true and false supported as default arguments" once the block is placed.
//     What a block shows comes from the `defl` annotation; in code the
//     parameter is optional and the function handles the omitted case.
//   - An omitted optional enum/number argument is NOT caught by
//     `x == undefined`: pxt compares numerically, the missing argument is NaN,
//     and NaN == NaN is false. `!(x >= 0)` is false for NaN and undefined alike.
//   - No default on an input that carries an enum shadow (who/target): the
//     shadow's field is an enum value, and a text default cannot be mapped
//     onto it. That includes "eg:" in a parameter's doc, which pxt also reads
//     as a default; the doc comments here say "for example" instead.
//   - A block input must not share its name with a draggable handler
//     parameter: Blockly keeps one input per name and drops the draggable one
//     (the handler then compiled as `function () {}`). Hence `source` for the
//     sender field next to the handler's `from`, and `which` next to `feed`.
//   - Device strings are bytes (utf8=false): literals are stored as Latin-1,
//     and the LED font has ASCII only. Texts this file returns (error
//     messages) therefore contain neither umlauts nor typographic dashes.
//   - No comment text may contain the annotation marker (two slashes and a
//     percent sign): pxt reads the rest of such a line as annotations.

/**
 * How often the collected values are sent.
 */
enum IotInterval {
    //% block="immediately"
    Immediately = 0,
    //% block="every second"
    EverySecond = 1000,
    //% block="every 5 seconds"
    Every5Seconds = 5000,
    //% block="every minute"
    EveryMinute = 60000,
    //% block="every hour"
    EveryHour = 3600000
}

/**
 * Whose values a receive or read block means. Two more entries than
 * IotTarget: "other devices" leaves out the dashboard (a dashboard is not a
 * device), "all but me" keeps it.
 */
enum IotWho {
    //% block="all"
    All = 0,
    //% block="dashboard"
    Dashboard = 1,
    //% block="other devices"
    OtherDevices = 2,
    //% block="all but me"
    AllButMe = 3,
    //% block="only this device"
    OnlyThisDevice = 4
}

/**
 * Who a sent value is for.
 */
enum IotTarget {
    //% block="all"
    All = 0,
    //% block="dashboard"
    Dashboard = 1
}

/**
 * State of the IoT connection.
 */
enum IotStatus {
    //% block="not connected"
    NotConnected = 0,
    //% block="connected"
    Connected = 1,
    //% block="sending"
    Sending = 2,
    //% block="error"
    Error = 3,
    //% block="no WiFi module"
    NoWifiModule = 4
}

/**
 * Send data to a Calliope Campus dashboard and receive data from it, over
 * WiFi or through the open Campus tab (USB, Bluetooth).
 */
//% weight=9 color=#0E7C86 icon="" block="IoT"
//% groups='["Connection","Send","Receive","Time","Diagnosis"]'
namespace iot {

    // The program asked for WiFi on a board that cannot do it (mini 1/2,
    // plan E1). The values then take the Campus path, and status/lastError say why.
    let wifiUnsupported = false
    // The program asked for WiFi (the simulator then plays "connected").
    let wifiRequested = false

    // ---- Connection ------------------------------------------------------

    /**
     * Connect to a WiFi network. Returns at once; the WiFi module starts in the
     * background (at the earliest 5 seconds after power-on). With this block in
     * the program, the values go over WiFi; without it, through the Campus tab.
     * @param ssid name of the WiFi network
     * @param password password of the WiFi network
     * @param tx pin the Calliope sends to the WiFi module on
     * @param rx pin the Calliope receives from the WiFi module on
     */
    //% blockId=iot_wifi_connect
    //% block="connect to WiFi $ssid password $password || TX $tx RX $rx"
    //% expandableArgumentMode="toggle"
    //% tx.defl=SerialPin.C17 rx.defl=SerialPin.C16
    //% tx.fieldEditor="gridpicker" tx.fieldOptions.columns=3 tx.fieldOptions.tooltips="false"
    //% rx.fieldEditor="gridpicker" rx.fieldOptions.columns=3 rx.fieldOptions.tooltips="false"
    //% group="Connection" weight=100 blockGap=8
    export function connectWifi(ssid: string, password: string, tx?: SerialPin, rx?: SerialPin): void {
        wifiRequested = true
        // Grove A1 unless the "+" says otherwise. NaN-safe: see the file header.
        if (!(tx >= 0)) tx = SerialPin.C17
        if (!(rx >= 0)) rx = SerialPin.C16
        if (iotcore.isSimulator()) {
            // No WiFi module in the simulator: its transport is the panel,
            // and the core ignores a WLAN sender there anyway.
            iotcore.start()
            return
        }
        if (!wifiSupported()) {
            // mini 1/2: not started at all. Redirecting the only UART would
            // also take USB serial away from the Campus path.
            wifiUnsupported = true
            iotcore.start()
            return
        }
        iotwifi.connect(ssid ? ssid : "", password ? password : "", tx, rx)
        // Started here too, so a program with only WiFi and clock blocks
        // still makes the first request (it brings the time).
        iotcore.start()
    }

    /**
     * Choose the dashboard the values belong to. Through the Campus tab the
     * reference may stay empty; Campus then takes the dashboard of the open program.
     * @param reference name or key of the dashboard (as shown in Campus)
     * @param server address of the Campus server
     */
    //% blockId=iot_dashboard
    //% block="connect to dashboard $reference || server $server"
    //% expandableArgumentMode="toggle"
    //% reference.defl=""
    //% server.defl="https://campus-api.calliope.cc"
    //% group="Connection" weight=99 blockGap=8
    export function connectDashboard(reference: string, server?: string): void {
        iotcore.setDashboard(reference, server)
    }

    /**
     * How often the collected values are sent. Without this block: every 5
     * seconds. Over WiFi at most once per second, even with "immediately".
     * @param interval how often to send
     */
    //% blockId=iot_interval
    //% block="send $interval"
    //% interval.defl=IotInterval.EverySecond
    //% group="Connection" weight=98
    export function setInterval(interval: IotInterval): void {
        // The core keeps the previous interval for NaN (omitted argument).
        iotcore.setInterval(interval)
    }

    // ---- Send ------------------------------------------------------------

    // The same feed to the same receiver goes at most every SAME_FEED_GAP_MS:
    // a send block called again sooner waits for the rest. Over WiFi about 8
    // values per second leave (one batch of 8 per ~1.1 s); a forever loop
    // without a pause queues ~50 per second, and what the buffer cannot hold is
    // dropped anyway. 250 ms means 4 per feed per second, so two feeds in such
    // a loop fill exactly what goes out. Different feeds never wait for each
    // other: "send temperature, send light" in a row is meant that way.
    const SAME_FEED_GAP_MS = 250
    const PACE_SLOTS = 16
    let paceKeys: string[] = []
    let paceTimes: number[] = []

    function pace(feed: string, to: string): void {
        const key = feed + "\n" + (to ? to : "")
        const i = paceKeys.indexOf(key)
        if (i < 0) {
            if (paceKeys.length >= PACE_SLOTS) {
                paceKeys.shift()
                paceTimes.shift()
            }
            paceKeys.push(key)
            paceTimes.push(control.millis())
            return
        }
        const wait = paceTimes[i] + SAME_FEED_GAP_MS - control.millis()
        if (wait > 0) basic.pause(wait)
        paceTimes[i] = control.millis()
    }

    /**
     * Send a number. It is collected and goes out with the next interval. The
     * same feed goes at most 4 times per second: called again sooner, the block
     * waits a moment.
     * @param feed name of the feed, for example "temperature"
     * @param value the number to send
     * @param to who gets the value: everyone, the dashboard, or a device number
     */
    //% blockId=iot_send
    //% block="send $feed = $value || to $to"
    //% expandableArgumentMode="toggle"
    //% feed.shadow="iot_feed_name"
    //% to.shadow="iot_target"
    //% group="Send" weight=90 blockGap=8
    export function send(feed: string, value: number, to?: string): void {
        pace(feed, to)
        iotcore.send(feed, value, to)
    }

    /**
     * Send a text (at most 160 characters). It is collected and goes out with
     * the next interval. The same feed goes at most 4 times per second: called
     * again sooner, the block waits a moment.
     * @param feed name of the feed, for example "message"
     * @param text the text to send
     * @param to who gets the text: everyone, the dashboard, or a device number
     */
    //% blockId=iot_send_text
    //% block="send text $feed = $text || to $to"
    //% expandableArgumentMode="toggle"
    //% feed.shadow="iot_feed_name"
    //% to.shadow="iot_target"
    //% group="Send" weight=89 blockGap=8
    export function sendText(feed: string, text: string, to?: string): void {
        pace(feed, to)
        iotcore.sendText(feed, text, to)
    }

    /**
     * Send the collected values now instead of waiting for the interval.
     * Over WiFi still at most once per second.
     */
    //% blockId=iot_send_now
    //% block="send now"
    //% group="Send" weight=88 blockGap=8
    export function sendNow(): void {
        iotcore.sendNow()
    }

    /**
     * Runs when a value of this program has really arrived: over WiFi when the
     * server confirmed it, through Campus when it left the Calliope.
     * @param which name of the feed, empty for every feed
     * @param handler code to run, with the feed, the value and the receiver
     */
    //% blockId=iot_on_sent
    //% block="on $which sent"
    //% draggableParameters="reporter"
    //% which.shadow="iot_feed_name"
    //% group="Send" weight=87
    export function onSent(which: string, handler: (feed: string, value: number, to: string) => void): void {
        // The feed field starts empty, and empty means "every feed".
        iotcore.onSent(which, handler)
    }

    // ---- Receive ---------------------------------------------------------

    /**
     * Runs when a number arrives on this feed, from the dashboard or
     * another device, and for the values this program sends itself. Only
     * values for everyone or for this device count.
     * @param feed name of the feed, for example "setpoint"
     * @param source whose values: all, the dashboard, other devices, or a device number
     * @param handler code to run, with the value, the sender and the receiver
     */
    //% blockId=iot_on_number
    //% block="on $feed received from $source"
    //% draggableParameters="reporter"
    //% feed.shadow="iot_feed_name"
    //% source.shadow="iot_who"
    //% group="Receive" weight=80 blockGap=8
    export function onNumber(feed: string, source: string, handler: (value: number, from: string, to: string) => void): void {
        iotcore.onNumber(feed, source, handler)
    }

    /**
     * Runs when a text (or a number, as text) arrives on this feed.
     * Only values for everyone or for this device count.
     * @param feed name of the feed, for example "message"
     * @param source whose values: all, the dashboard, other devices, or a device number
     * @param handler code to run, with the text, the sender and the receiver
     */
    //% blockId=iot_on_text
    //% block="on text $feed received from $source"
    //% draggableParameters="reporter"
    //% feed.shadow="iot_feed_name"
    //% source.shadow="iot_who"
    //% group="Receive" weight=79 blockGap=8
    export function onText(feed: string, source: string, handler: (text: string, from: string, to: string) => void): void {
        iotcore.onText(feed, source, handler)
    }

    /**
     * The latest number on this feed (0 if none yet). Reads what has
     * already arrived and never waits for the network. Without a receiver it
     * sees values for everyone and for this device.
     * @param feed name of the feed, for example "setpoint"
     * @param from only values from this sender
     * @param to only values for exactly this receiver
     */
    //% blockId=iot_read
    //% block="read $feed || from $from to $to"
    //% expandableArgumentMode="toggle"
    //% feed.shadow="iot_feed_name"
    //% from.shadow="iot_who"
    //% to.shadow="iot_who"
    //% group="Receive" weight=78 blockGap=8
    export function read(feed: string, from?: string, to?: string): number {
        return iotcore.read(feed, from, to)
    }

    /**
     * The latest value on this feed as text ("" if none yet). Reads
     * what has already arrived and never waits for the network.
     * @param feed name of the feed, for example "message"
     * @param from only values from this sender
     * @param to only values for exactly this receiver
     */
    //% blockId=iot_read_text
    //% block="read text $feed || from $from to $to"
    //% expandableArgumentMode="toggle"
    //% feed.shadow="iot_feed_name"
    //% from.shadow="iot_who"
    //% to.shadow="iot_who"
    //% group="Receive" weight=77
    export function readText(feed: string, from?: string, to?: string): string {
        return iotcore.readText(feed, from, to)
    }

    /**
     * A sender or receiver chosen from a list. Hidden: it only sits in the
     * "from"/"to" inputs; pulled out, the input takes a device number or a variable.
     * @param w whose values
     */
    //% blockId=iot_who
    //% block="$w"
    //% blockHidden=true
    //% weight=1
    export function who(w: IotWho): string {
        if (w == IotWho.Dashboard) return iotcore.WHO_DASHBOARD
        if (w == IotWho.OtherDevices) return iotcore.WHO_OTHERS
        if (w == IotWho.AllButMe) return iotcore.WHO_ALL_BUT_ME
        if (w == IotWho.OnlyThisDevice) return iotcore.WHO_ME
        return iotcore.WHO_ALL
    }

    /**
     * A receiver chosen from a list. Hidden: it only sits in the "to" inputs
     * of the send blocks; pulled out, the input takes a device number or a variable.
     * @param t who gets the value
     */
    //% blockId=iot_target
    //% block="$t"
    //% blockHidden=true
    //% weight=1
    export function target(t: IotTarget): string {
        return t == IotTarget.Dashboard ? iotcore.WHO_DASHBOARD : iotcore.WHO_ALL
    }

    // The feed name that sits in every feed input: a text field whose list
    // offers the feed names already used elsewhere in the program (pxt's
    // "autocomplete" editor, the pattern of the datalogger's column field).
    // The extension defines it itself because a shadow whose block does not
    // exist breaks the program: pxt then refuses to open it as blocks. Campus
    // therefore must not define a block with this id (pxt keeps one
    // definition per id, and not the same one everywhere). TD_ID: the block
    // compiles to the bare text, so the code reads iot.send("temp", 5).
    //% blockId=iot_feed_name
    //% block="$feed"
    //% blockHidden=true shim=TD_ID
    //% feed.fieldEditor="autocomplete" feed.fieldOptions.decompileLiterals=true
    //% feed.fieldOptions.key="iotfeed"
    export function _feedField(feed: string): string {
        return feed
    }

    // ---- Time ------------------------------------------------------------

    /**
     * True once the server has sent the time. Until then a clock should show
     * "--:--" rather than a wrong number.
     */
    //% blockId=iot_time_known
    //% block="time known?"
    //% group="Time" weight=60 blockGap=8
    export function timeKnown(): boolean {
        return iotcore.timeKnown()
    }

    /**
     * The time of day as text, for example "14:37" ("--:--" while the time is unknown).
     */
    //% blockId=iot_time
    //% block="time"
    //% group="Time" weight=59 blockGap=8
    export function time(): string {
        if (!iotcore.timeKnown()) return "--:--"
        return twoDigits(hour()) + ":" + twoDigits(minute())
    }

    /**
     * The hour (0 to 23), or 0 while the time is unknown.
     */
    //% blockId=iot_hour
    //% block="hour"
    //% group="Time" weight=58 blockGap=8
    export function hour(): number {
        if (!iotcore.timeKnown()) return 0
        return Math.floor(iotcore.localSeconds() / 3600) % 24
    }

    /**
     * The minute (0 to 59), or 0 while the time is unknown.
     */
    //% blockId=iot_minute
    //% block="minute"
    //% group="Time" weight=57 blockGap=8
    export function minute(): number {
        if (!iotcore.timeKnown()) return 0
        return Math.floor(iotcore.localSeconds() / 60) % 60
    }

    /**
     * The second (0 to 59), or 0 while the time is unknown.
     */
    //% blockId=iot_second
    //% block="second"
    //% group="Time" weight=56 blockGap=8
    export function second(): number {
        if (!iotcore.timeKnown()) return 0
        return iotcore.localSeconds() % 60
    }

    /**
     * The date as text, for example "13.10.2026" ("--.--.----" while the time is unknown).
     */
    //% blockId=iot_date
    //% block="date"
    //% group="Time" weight=55 blockGap=8
    export function date(): string {
        if (!iotcore.timeKnown()) return "--.--.----"
        const days = Math.floor(iotcore.localSeconds() / 86400)
        // Civil date from days since 1970 (Howard Hinnant's algorithm):
        // integer arithmetic only, no table, leap years included.
        const z = days + 719468
        const era = Math.floor(z / 146097)
        const doe = z - era * 146097
        const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
        const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
        const mp = Math.floor((5 * doy + 2) / 153)
        const day = doy - Math.floor((153 * mp + 2) / 5) + 1
        const month = mp < 10 ? mp + 3 : mp - 9
        const year = month <= 2 ? yoe + era * 400 + 1 : yoe + era * 400
        return twoDigits(day) + "." + twoDigits(month) + "." + year
    }

    /**
     * Seconds since 1 January 1970 (UTC), for your own calculations; 0 while
     * the time is unknown.
     */
    //% blockId=iot_timestamp
    //% block="unix time"
    //% group="Time" weight=54
    export function timestamp(): number {
        return iotcore.unixSeconds()
    }

    function twoDigits(n: number): string {
        return n < 10 ? "0" + n : "" + n
    }

    // ---- Diagnosis -------------------------------------------------------

    /**
     * The state of the IoT connection: not connected, connected, sending,
     * error, or no WiFi module.
     */
    //% blockId=iot_status
    //% block="IoT status"
    //% group="Diagnosis" weight=40 blockGap=8
    export function status(): IotStatus {
        if (wifiUnsupported) return IotStatus.NoWifiModule
        if (!iotcore.usesWlan()) return iotcore.status()
        // WLAN: until the module is in the network, the WiFi state is the
        // answer; the core's own state then only says "requests fail".
        if (!iotwifi.isOnline()) {
            const e = iotwifi.lastError()
            if (e == "no-module" || e.substr(0, 4) == "uart") return IotStatus.NoWifiModule
            if (e == "wrong-password" || e == "ap-not-found" || e.substr(0, 5) == "join-") return IotStatus.Error
            return IotStatus.NotConnected
        }
        const s = iotcore.status()
        // A request that failed while WiFi was still joining is history.
        if (s == iotcore.STATE_ERROR && iotcore.lastError() == "offline") return IotStatus.NotConnected
        return s
    }

    /**
     * A status to compare with, for example IoT status = connected.
     * @param s the status
     */
    //% blockId=iot_status_value
    //% block="$s"
    //% shim=TD_ID
    //% group="Diagnosis" weight=39 blockGap=8
    export function statusValue(s: IotStatus): IotStatus {
        return s
    }

    /**
     * True while the WiFi module is in the WiFi network.
     */
    //% blockId=iot_wifi_connected
    //% block="WiFi connected?"
    //% group="Diagnosis" weight=38 blockGap=8
    export function wifiConnected(): boolean {
        // The simulator plays a working network once the program asked for one.
        if (iotcore.isSimulator()) return wifiRequested
        if (wifiUnsupported) return false
        return iotwifi.isOnline()
    }

    /**
     * WiFi signal strength in dBm, for example -60 (closer to 0 is better; 0 = not measured yet).
     */
    //% blockId=iot_wifi_signal
    //% block="WiFi signal"
    //% group="Diagnosis" weight=37 blockGap=8
    export function wifiSignal(): number {
        if (wifiUnsupported) return 0
        return iotwifi.rssi()
    }

    /**
     * What went wrong last, as readable text ("" if nothing).
     */
    //% blockId=iot_last_error
    //% block="last error"
    //% group="Diagnosis" weight=36 blockGap=8
    export function lastError(): string {
        if (wifiUnsupported) return "WLAN geht nur mit dem Calliope mini 3"
        if (iotcore.usesWlan() && !iotwifi.isOnline()) {
            const w = iotwifi.lastError()
            if (w != "") return errorText(w)
        }
        return errorText(iotcore.lastError())
    }

    /**
     * The name of this Calliope as Campus shows it, for example "zogop". For display
     * only: two devices can have the same name.
     */
    //% blockId=iot_device_id
    //% block="my device name"
    //% group="Diagnosis" weight=35 blockGap=8
    export function deviceName(): string {
        return iotcore.deviceName()
    }

    /**
     * Write a line to the Campus log.
     * @param text the text to log
     */
    //% blockId=iot_log
    //% block="log $text"
    //% group="Diagnosis" weight=34
    export function log(text: string): void {
        iotcore.log(text)
    }

    /**
     * Firmware version of the WiFi module, for example "3.3.0.0" ("" until it answered).
     */
    //% blockId=iot_module_version
    //% block="WiFi module version"
    //% advanced=true
    //% group="Diagnosis" weight=20 blockGap=8
    export function moduleVersion(): string {
        return iotwifi.moduleVersion()
    }

    /**
     * What the WiFi module is and can do, for example "ESP32C3 AT 3.3.0.0 http tls"
     * ("" until it answered).
     */
    //% blockId=iot_module_info
    //% block="WiFi module info"
    //% advanced=true
    //% group="Diagnosis" weight=19
    export function moduleInfo(): string {
        const family = iotwifi.moduleFamily()
        if (family == 0) return ""
        const caps = iotwifi.capabilities()
        let s = iotwifi.moduleChip()
        if (s == "") s = family == iotwifi.FAMILY_AT1 ? "ESP8266" : "ESP"
        s += " AT " + iotwifi.moduleVersion()
        if ((caps & iotwifi.CAP_HTTP) != 0) s += " http"
        if ((caps & iotwifi.CAP_TLS) != 0) s += " tls"
        if (iotwifi.passiveReceive()) s += " passive"
        return s
    }

    /**
     * The codes of the core, the WLAN client and the server as text for a
     * child. German (the device cannot know the editor language), without
     * umlauts (see the file header). Unknown codes stay as they are.
     */
    function errorText(code: string): string {
        if (code == "") return ""
        // WiFi module and network (iotwifi.lastError)
        if (code == "no-module" || code == "stuck") return "WLAN-Modul antwortet nicht - kurz vom Strom trennen"
        if (code == "uart-2") return "WLAN-Modul: falsche Pins"
        if (code == "uart-3") return "WLAN: zu wenig Speicher"
        if (code.substr(0, 4) == "uart") return "WLAN-Modul: Anschluss belegt"
        if (code == "module-reset" || code == "reset") return "WLAN-Modul ist neu gestartet"
        if (code == "module-busy" || code == "busy") return "WLAN-Modul arbeitet noch"
        if (code == "wrong-password") return "falsches WLAN-Passwort"
        if (code == "ap-not-found") return "WLAN nicht gefunden"
        if (code == "join-timeout") return "WLAN-Anmeldung dauert zu lange"
        if (code == "join-failed") return "WLAN-Anmeldung fehlgeschlagen"
        if (code == "wifi-lost" || code == "wifi") return "WLAN-Verbindung verloren"
        if (code == "offline") return "noch nicht im WLAN"
        // The request (Answer.error)
        if (code == "tls") return "WLAN-Modul kann kein https"
        if (code == "bad-url") return "falsche Serveradresse"
        if (code == "dns") return "Server nicht gefunden"
        if (code == "connect") return "Server nicht erreichbar"
        if (code == "timeout" || code == "no-answer") return "Server antwortet nicht"
        if (code == "send") return "Senden abgebrochen"
        if (code == "too-big") return "zu viele Daten auf einmal"
        if (code == "bad-answer") return "seltsame Antwort vom Server"
        if (code.substr(0, 5) == "http-") return "Serverfehler " + code.substr(5, code.length - 5)
        // The server (iot.pb.js)
        if (code == "bad_token" || code == "no_write_token") return "falsche Dashboard-Referenz"
        if (code == "too_fast") return "zu schnell gesendet"
        if (code == "device_blocked") return "im Dashboard gesperrt"
        if (code == "write_failed") return "Server konnte nicht speichern"
        return code
    }

    /** True on boards with a WiFi path: mini 3 (CODAL). DAL boards (mini 1/2) report "1". */
    function wifiSupported(): boolean {
        return control._hardwareVersion().charAt(0) != "1"
    }
}
