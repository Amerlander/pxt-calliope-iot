/**
 * The contract between the IoT core and the WLAN transport.
 *
 * Shared by `iotcore.ts` (owns the send buffer, cache, handlers) and
 * `wlanclient.ts` (owns the module and the HTTP ingest). Kept in its own file
 * so neither side has to read the other's internals: the core freezes points
 * into a Batch, the client turns a Batch into one ingest request and the
 * server's reply into an Answer. Campus (USB/BLE) and the simulator do not use
 * these types — they are line protocols, see docs/interfaces.md.
 *
 * Parallel arrays instead of an object per point: on the device every object
 * is a heap block, and a batch is built every few seconds.
 */
namespace iotcore {
    /** Upper bound of points per request — what the server's cursor sizes assume (iot.pb.js). */
    export const BATCH_MAX = 8;

    /** One request's worth of points, frozen when handed to a transport. */
    export class Batch {
        /** `s` in the ingest body: increases per request within one boot, for server-side dedup. */
        seq: number;
        /** Normalised feed keys (lowercase, ':' → '_'). */
        feeds: string[];
        /** JSON literals, ready to splice: `21.5` or `"text"` (already escaped). */
        values: string[];
        /** Addressee per point: "" everyone, "0" dashboard, otherwise a device id. */
        tos: string[];
        /** Milliseconds since each point was queued (≥ 0). The request sends dt = -age. */
        ages: number[];
        /** Spellings to announce (`n` in the body): key i ↔ label i, only where label ≠ key. */
        labelKeys: string[];
        labelTexts: string[];

        constructor() {
            this.seq = 0;
            this.feeds = [];
            this.values = [];
            this.tos = [];
            this.ages = [];
            this.labelKeys = [];
            this.labelTexts = [];
        }
    }

    /** Everything an ingest request needs besides the points. Filled by the core. */
    export class IngestContext {
        /** Reference from the Dashboard block: slug, `R-…`, `W-…` or `slug:R-…:W-…`. */
        ref: string;
        /** Ingest base URL, e.g. `https://campus-api.calliope.cc/api/iot/v1`. */
        server: string;
        /** Device id as decimal string (`deviceSerialNumber() >>> 0`). */
        dev: string;
        /** Read scope: "d" dashboard, "g" devices, "a" all. */
        scope: string;
        /** Downlink cursor: 0 = "want one, have none", > 0 = continue from there. */
        since: number;
        /** Random per boot (≤ 32 chars); with Batch.seq the server drops replayed batches. */
        boot: string;

        constructor() {
            this.ref = "";
            this.server = "";
            this.dev = "";
            this.scope = "d";
            this.since = 0;
            this.boot = "";
        }
    }

    // ---- where the WLAN client plugs in ----------------------------------
    //
    // The core never calls iotwifi.* directly: a program without the WLAN block
    // must not pull the WiFi stack in, and the two files are built independently.
    // `iotwifi.connect()` registers its sender here; the core sends through it
    // from its own sender fiber (the call blocks for the whole HTTP exchange).

    let wlanSendFn: (batch: Batch, ctx: IngestContext) => Answer = null;

    /** Called by the WLAN client when the program connects to WiFi. */
    export function setWlanSender(fn: (batch: Batch, ctx: IngestContext) => Answer): void {
        wlanSendFn = fn;
    }

    /** The registered sender, or null when the program uses the Campus path. */
    export function wlanSender(): (batch: Batch, ctx: IngestContext) => Answer {
        return wlanSendFn;
    }

    // Putting the module to sleep goes through a hook too, for the same
    // reason. Sleep means radio off; the sender wakes it again by itself
    // (radio on, join) before the next request.
    let wlanSleepFn: () => void = null;

    /** Called by the WLAN client together with setWlanSender. */
    export function setWlanSleeper(fn: () => void): void {
        wlanSleepFn = fn;
    }

    /** The registered sleeper, or null (Campus path, simulator). */
    export function wlanSleeper(): () => void {
        return wlanSleepFn;
    }

    /** Outcome of one transport attempt, plus whatever came back downstream. */
    export class Answer {
        /** The server accepted the batch (`"ok":1`, including `"dup":1`). */
        ok: boolean;
        /** The server had already written this batch (idempotent retry). */
        dup: boolean;
        /** Short reason when !ok: server `error` code, or "wifi", "timeout", "http-<status>", "tls". */
        error: string;
        /** Server back-off request in ms (from `retry_after`), 0 if none. */
        retryAfterMs: number;
        /** Server clock: unix seconds and zone offset in minutes; NaN if absent. */
        serverSec: number;
        tzoMin: number;
        /** Downlink cursor to send as `since` next time; -1 if the answer had none. */
        cur: number;
        /** The server holds more downlink than fit: ask again soon. */
        more: boolean;
        /** Downlink rows, in server order: feed key, raw value (JSON literal), sender, addressee. */
        dFeeds: string[];
        dValues: string[];
        dFroms: string[];
        dTos: string[];

        constructor() {
            this.ok = false;
            this.dup = false;
            this.error = "";
            this.retryAfterMs = 0;
            this.serverSec = NaN;
            this.tzoMin = NaN;
            this.cur = -1;
            this.more = false;
            this.dFeeds = [];
            this.dValues = [];
            this.dFroms = [];
            this.dTos = [];
        }
    }
}
