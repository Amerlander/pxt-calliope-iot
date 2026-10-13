#!/usr/bin/env python3
"""Oracle for programs/usb-integrity.ts: is USB serial output intact while the
module talks on UARTE1?

The device writes `U<n>:<32 fixed chars>:<hash>` lines nonstop between
`=====USBSTART ...=====` and `=====USBSUM=====`, then a summary up to
`=====USBEND=====`. This reads the port (or a saved capture), checks every line
and counts corrupt and missing ones.

  python tools/hil/usbcheck.py [--port COMx] [--no-reset] [--timeout 150]
                               [--save capture.txt] [--expect clean|corrupt]
  python tools/hil/usbcheck.py --file capture.txt

--expect clean   (default) exit 1 unless every line is intact, none is missing
                 and the module side reports no failed command.
--expect corrupt exit 1 unless corruption was seen: the "before" run with
                 TXMODE=ring, proving the test can see the bug at all.
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
FILL = "abcdefghijklmnopqrstuvwxyz012345"
START = "=====USBSTART"
SUM = "=====USBSUM====="
END = "=====USBEND====="
OVERFLOW = "<DAPLink:Overflow>"
LINE_RE = re.compile(r"^U(\d+):([^:]*):(\d+)$")


def line_hash(s: str) -> int:
    """Same function as hash() in usb-integrity.ts."""
    h = 0
    for ch in s:
        h = (h * 31 + ord(ch)) & 0xFFFF
    return h


def capture(port: str | None, reset: bool, timeout: float) -> str:
    sys.path.insert(0, str(HERE))
    import hil  # find_port / secrets scrubbing live there
    import serial  # pyserial

    dev = hil.find_port(port)
    deadline = time.time() + timeout
    s = None
    while s is None and time.time() < deadline:
        try:
            s = serial.Serial(dev, 115200, timeout=0.3)
        except Exception:
            time.sleep(1)  # the port re-enumerates after a flash
    if s is None:
        hil.die(f"could not open {dev}")
    if reset:
        s.send_break(0.3)  # DAPLink resets the target on a serial break
    print(f"[usbcheck] reading {dev} (up to {timeout:.0f} s)...", flush=True)
    raw = bytearray()
    while time.time() < deadline:
        raw += s.read(8192)
        if END.encode() in raw:
            time.sleep(0.3)
            raw += s.read(8192)
            break
    s.close()
    # latin-1 keeps every byte as one character: corruption stays visible.
    return hil.scrub(raw.decode("latin-1"), hil.load_secrets())


def analyse(text: str) -> dict:
    r: dict = {"start": None, "summary": {}, "valid": 0, "corrupt": [], "seen": set(),
               "dups": 0, "order": 0, "device_lines": None, "complete": False}
    i = text.rfind(START)  # the last run if a reset replayed the start
    if i < 0:
        return r
    eol = text.find("\n", i)
    r["start"] = text[i:eol if eol >= 0 else None].strip()
    body_from = eol + 1 if eol >= 0 else len(text)
    j = text.find(SUM, body_from)
    body = text[body_from:j if j >= 0 else None]
    if j >= 0:
        k = text.find(END, j)
        r["complete"] = k >= 0
        for ln in text[j + len(SUM):k if k >= 0 else None].splitlines():
            ln = ln.strip()
            if "=" in ln:
                key = ln.split("=", 1)[0].split()[0]
                r["summary"][key] = ln
        m = re.search(r"lines=(\d+)", r["summary"].get("lines", ""))
        if m:
            r["device_lines"] = int(m.group(1))
    last = 0
    r["overflows"] = 0
    after_overflow = False
    for ln in body.split("\n"):
        ln = ln.rstrip("\r")
        if not ln:
            continue
        # The DAPLink writes this marker into the stream when its own serial
        # buffer overflowed (the host or its USB side fell behind). The bytes
        # lost there never left the DAPLink: the line it lands in and the
        # fragment after it are DAPLink damage, not device output.
        if OVERFLOW in ln:
            r["overflows"] += 1
            after_overflow = True
            continue
        if after_overflow:
            after_overflow = False
            if not LINE_RE.match(ln):
                continue
        m = LINE_RE.match(ln)
        ok = (m is not None and m.group(2) == FILL and
              int(m.group(3)) == line_hash(f"U{m.group(1)}:{m.group(2)}"))
        if not ok:
            r["corrupt"].append(ln)
            continue
        n = int(m.group(1))
        r["valid"] += 1
        if n in r["seen"]:
            r["dups"] += 1
        if n < last:
            r["order"] += 1
        last = n
        r["seen"].add(n)
    return r


def module_side_bad(summary: dict) -> list[str]:
    """Failed module commands from the summary: TX corruption on UARTE1 would show here."""
    bad = []
    # usb-integrity.ts reports at/gmr/junk, usb-wifi.ts reports posts.
    keys = [k for k in ("at", "gmr", "junk", "posts") if k in summary] or ["at", "gmr", "junk"]
    for key in keys:
        m = re.search(r"ok=(\d+) bad=(\d+)", summary.get(key, ""))
        if not m:
            bad.append(f"{key}: no counters")
        elif int(m.group(2)) > 0 or int(m.group(1)) == 0:
            bad.append(f"{key}: ok={m.group(1)} bad={m.group(2)}")
    return bad


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port")
    p.add_argument("--file", help="analyse a saved capture instead of reading the port")
    p.add_argument("--save", help="write the raw capture here")
    p.add_argument("--no-reset", action="store_true", help="do not reset the target via serial break")
    p.add_argument("--timeout", type=float, default=150)
    p.add_argument("--expect", choices=["clean", "corrupt"], default="clean")
    a = p.parse_args()

    if a.file:
        text = Path(a.file).read_bytes().decode("latin-1")
    else:
        text = capture(a.port, not a.no_reset, a.timeout)
        if a.save:
            Path(a.save).write_bytes(text.encode("latin-1"))

    r = analyse(text)
    if r["start"] is None:
        print("[usbcheck] no USBSTART marker: program not running, or the port opened too late")
        sys.exit(2)
    total = r["device_lines"]
    top = total if total is not None else (max(r["seen"]) if r["seen"] else 0)
    missing = [n for n in range(1, top + 1) if n not in r["seen"]]
    print(r["start"])
    for v in r["summary"].values():
        print("  " + v)
    print(f"lines written (device): {total if total is not None else '? (no summary)'}")
    print(f"lines intact:           {r['valid']}")
    print(f"lines corrupt:          {len(r['corrupt'])}")
    for ln in r["corrupt"][:8]:
        print(f"    {ln!r}")
    print(f"numbers missing:        {len(missing)} {missing[:12]}")
    gaps = sum(1 for i, n in enumerate(missing) if i == 0 or missing[i - 1] != n - 1)
    # One overflow loses one contiguous run of lines. If every gap is matched by
    # a marker, the loss happened in the DAPLink, not on the device.
    dap_only = bool(missing) and gaps <= r["overflows"]
    print(f"DAPLink overflows:      {r['overflows']}" +
          (f" (explain all {gaps} gap(s): lost in the DAPLink, not on the device)" if dap_only else ""))
    print(f"duplicates / reordered: {r['dups']} / {r['order']}")
    module_bad = module_side_bad(r["summary"])
    print(f"module side:            {'OK' if not module_bad else '; '.join(module_bad)}")

    usb_corrupt = bool(r["corrupt"] or (missing and not dap_only) or r["dups"])
    if not r["complete"]:
        print("[usbcheck] summary incomplete (no USBEND): run cut short?")
    if a.expect == "corrupt":
        verdict_ok = usb_corrupt
        print(f"VERDICT: {'corruption seen, as expected for the old TX path' if verdict_ok else 'NO corruption seen: the test did not reproduce the bug'}")
    else:
        verdict_ok = r["complete"] and not usb_corrupt and not module_bad and top > 0
        print(f"VERDICT: {'CLEAN' if verdict_ok else 'FAILED'}")
    sys.exit(0 if verdict_ok else 1)


if __name__ == "__main__":
    main()
