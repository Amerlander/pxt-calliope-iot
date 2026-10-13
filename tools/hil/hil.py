#!/usr/bin/env python3
"""
Hardware-in-the-loop for the iot extension.

The loop this automates was built by hand while debugging the WiFi path on a
real Calliope mini 3 + ESP32-C3 (2026-09-29): build a program with the pxt CLI
against the LOCAL target and the LOCAL extension, flash it by copying the hex
onto the MINI drive, read what the device prints over USB serial, and ask the
local PocketBase what actually arrived. Every step has a failure mode that cost
time once, and the checks for it live here:

  * pxt needs `node_modules/pxtcli.json` and the target's own pxt-core, or it
    refuses with "Couldn't find PXT"; `pxt install` is needed once before the
    first build or it fails with "Package not installed: core".
  * The DAPLink writes FAIL.TXT when it cannot program the target (a browser
    tab still holding the debug interface over WebUSB, a hex that writes UICR).
  * A DAPLink that has hung simply leaves the copied file on the drive and
    never programs it. Only unplugging helps; this tool says so instead of
    waiting forever.
  * Secrets (WiFi password, write token) end up in program text and in traces.
    They are substituted from `secret.json` (gitignored) and scrubbed from
    everything printed.

Subcommands
-----------
  build   <program.ts> [--variant v3|v2] [--name N] [--no-ext]
  flash   <hex> [--drive D:]
  trace   [--port COMx] [--start MARK] [--end MARK] [--timeout S] [--reset]
  logs    [--since ISO] [--path /api/iot/v1/ingest] [--lan]
  points  [--since ISO] [--feed F]
  run     <program.ts> [build/flash/trace options] [--expect-ingest N] [--expect TEXT ...]

`run` is build + flash + trace (+ checks) and exits non-zero on a failed check.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import sqlite3
import string
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent  # the extension repo
CALLIOPE_DEV = REPO.parent.parent.parent  # .../calliope-dev
TARGET = CALLIOPE_DEV / "editors" / "makecode" / "pxt-calliope"
CAMPUS = CALLIOPE_DEV / "editors" / "calliope-campus"
PB_DATA = CAMPUS / "pocketbase" / "pb_data"
WORK = HERE / ".work"
SECRET = HERE / "secret.json"

# USB ids of the interface chips: DAPLink on mini 3, SEGGER J-Link OB on mini 2.
USB_VIDS = {0x0D28: "DAPLink (mini 3)", 0x1366: "J-Link (mini 2)"}


# ---------------------------------------------------------------- helpers

def log(msg: str) -> None:
    print(f"[hil] {msg}", flush=True)


def die(msg: str, code: int = 2) -> None:
    print(f"[hil] ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def load_secrets() -> dict:
    if not SECRET.exists():
        return {}
    try:
        return json.loads(SECRET.read_text(encoding="utf-8"))
    except Exception as e:  # a broken secret file must not look like "no secrets"
        die(f"{SECRET} is not valid JSON: {e}")
    return {}


def scrub(text: str, secrets: dict) -> str:
    """Never print a password or a write token, even inside a device trace."""
    for key in ("pw", "ref"):
        value = str(secrets.get(key) or "")
        if len(value) >= 4:
            text = text.replace(value, f"<{key}>")
    return text


def junction(link: Path, target: Path) -> None:
    if link.exists():
        return
    link.parent.mkdir(parents=True, exist_ok=True)
    # mklink /J needs no admin rights, unlike a symlink.
    # cmd answers in the OEM code page ("Verknüpfung erstellt"), not UTF-8.
    r = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                       capture_output=True, text=True, encoding="oem", errors="replace")
    if r.returncode != 0:
        die(f"could not create junction {link} -> {target}: {r.stdout}{r.stderr}")


def pxt_cmd() -> list[str]:
    exe = shutil.which("pxt") or shutil.which("pxt.cmd")
    if not exe:
        die("global `pxt` CLI not found (npm i -g pxt)")
    return [exe]


def run_pxt(args: list[str], cwd: Path, timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(pxt_cmd() + args, cwd=str(cwd), capture_output=True,
                          text=True, encoding="utf-8", errors="replace", timeout=timeout)


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------- build

def prepare_project(name: str, variant: str, with_ext: bool, extra_deps: dict) -> Path:
    proj = WORK / name
    nm = proj / "node_modules"
    nm.mkdir(parents=True, exist_ok=True)
    junction(nm / "pxt-calliope", TARGET)
    junction(nm / "pxt-core", TARGET / "node_modules" / "pxt-core")
    junction(nm / "pxt-common-packages", TARGET / "node_modules" / "pxt-common-packages")
    (nm / "pxtcli.json").write_text(json.dumps({"targetdir": "pxt-calliope"}), encoding="utf-8")
    deps = {"core": "*", variant: "*"}
    if with_ext:
        junction(proj / "ext", REPO)
        deps["iot"] = "file:ext"
    for dep_name, spec in extra_deps.items():
        # `name=file:C:/abs/path` — pxt resolves file: deps relative to the
        # project, so an absolute path gets a junction inside it.
        if spec.startswith("file:") and Path(spec[5:]).is_absolute():
            junction(proj / "deps" / dep_name, Path(spec[5:]))
            spec = f"file:deps/{dep_name}"
        deps[dep_name] = spec
    pxt_json = {"name": f"hil-{name}", "dependencies": deps, "files": ["main.ts"],
                "preferredEditor": "tsprj"}
    wanted = json.dumps(pxt_json, indent=4)
    pj = proj / "pxt.json"
    if not pj.exists() or pj.read_text(encoding="utf-8") != wanted:
        pj.write_text(wanted, encoding="utf-8")
        # Dependencies changed: the installed modules are stale.
        shutil.rmtree(proj / "pxt_modules", ignore_errors=True)
    return proj


def render_program(src: Path, secrets: dict, variables: dict | None = None) -> str:
    text = src.read_text(encoding="utf-8")
    # `$SSID`-style placeholders; unknown ones stay untouched so a program can
    # carry its own `$`s. `--var KEY=VALUE` adds more (program variants).
    mapping = {"SSID": secrets.get("ssid", ""), "PW": secrets.get("pw", ""),
               "REF": secrets.get("ref", ""), "SERVER": secrets.get("server", "")}
    mapping.update(variables or {})
    return string.Template(text).safe_substitute(mapping)


def cmd_build(a) -> Path:
    src = Path(a.program).resolve()
    if not src.exists():
        die(f"program not found: {src}")
    name = a.name or f"{src.stem}-{a.variant}"
    extra = dict(kv.split("=", 1) for kv in (a.dep or []))
    proj = prepare_project(name, a.variant, not a.no_ext, extra)
    variables = dict(kv.split("=", 1) for kv in (getattr(a, "var", None) or []))
    (proj / "main.ts").write_text(render_program(src, load_secrets(), variables), encoding="utf-8")
    if not (proj / "pxt_modules").exists():
        log(f"pxt install ({name})")
        r = run_pxt(["install"], proj, 600)
        if r.returncode != 0:
            die("pxt install failed:\n" + (r.stdout + r.stderr)[-3000:])
    log(f"pxt build ({name}, {a.variant})")
    t0 = time.time()
    r = run_pxt(["build"], proj, 900)
    out = r.stdout + r.stderr
    errors = [l for l in out.splitlines() if "error" in l.lower() and "0 error" not in l.lower()]
    hexfile = proj / "built" / "binary.hex"
    if r.returncode != 0 or not hexfile.exists():
        die("pxt build failed:\n" + "\n".join(errors[-40:] or out.splitlines()[-40:]))
    log(f"built {hexfile} ({hexfile.stat().st_size // 1024} KB, {time.time() - t0:.0f} s)")
    return hexfile


# ---------------------------------------------------------------- flash

def find_drive(explicit: str | None) -> Path:
    if explicit:
        p = Path(explicit if explicit.endswith(("\\", "/")) else explicit + "\\")
        if not (p / "DETAILS.TXT").exists():
            die(f"{p} does not look like a MINI/MICROBIT drive (no DETAILS.TXT)")
        return p
    for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
        p = Path(f"{letter}:\\")
        try:
            if (p / "DETAILS.TXT").exists():
                return p
        except OSError:
            continue
    die("no MINI drive found (is the Calliope plugged in?)")
    raise SystemExit  # unreachable, for type checkers


def cmd_flash(a) -> None:
    hexfile = Path(a.hex).resolve()
    drive = find_drive(a.drive)
    for stale in drive.glob("*.hex"):
        # A hex still lying on the drive means an earlier copy was never
        # programmed: the DAPLink has hung.
        die(f"{stale.name} is still on {drive} — the DAPLink did not program the last copy. "
            "Unplug the Calliope and plug it back in.")
    name = f"hil{int(time.time()) % 100000}.hex"
    log(f"flashing {hexfile.name} -> {drive}{name}")
    shutil.copyfile(hexfile, drive / name)
    # The DAPLink programs, then re-enumerates: the copied file disappears.
    deadline = time.time() + a.timeout
    gone = False
    while time.time() < deadline:
        time.sleep(1)
        try:
            if not (drive / name).exists():
                gone = True
                break
        except OSError:
            pass  # drive is mid re-enumeration
    if not gone:
        die(f"{name} still on the drive after {a.timeout} s — DAPLink hung. Unplug and replug.")
    # Give the drive time to come back before judging FAIL.TXT.
    for _ in range(15):
        time.sleep(1)
        try:
            if (drive / "DETAILS.TXT").exists():
                break
        except OSError:
            pass
    fail = drive / "FAIL.TXT"
    try:
        if fail.exists():
            die("DAPLink reports: " + fail.read_text(errors="replace").strip() +
                "\n  (a browser tab holding the device over WebUSB? close it and replug)")
    except OSError:
        pass
    log("flashed")


# ---------------------------------------------------------------- trace

def find_port(explicit: str | None) -> str:
    if explicit:
        return explicit
    try:
        from serial.tools import list_ports
    except ImportError:
        die("pyserial missing (pip install pyserial)")
    for p in list_ports.comports():
        if p.vid in USB_VIDS:
            return p.device
    die("no Calliope serial port found")
    return ""


def cmd_trace(a) -> str:
    import serial  # pyserial
    secrets = load_secrets()
    port = find_port(a.port)
    deadline = time.time() + (getattr(a, "trace_timeout", None) or a.timeout)
    s = None
    while s is None and time.time() < deadline:
        try:
            s = serial.Serial(port, 115200, timeout=0.3)
        except Exception:
            time.sleep(1)  # the port re-enumerates after a flash
    if s is None:
        die(f"could not open {port}")
    if a.reset:
        s.send_break(0.3)  # DAPLink resets the target on a serial break
    buf = ""
    while time.time() < deadline:
        buf += s.read(4096).decode(errors="replace")
        if a.end and a.end in buf and (not a.start or a.start in buf):
            # Read a little more so the end marker's line is complete.
            time.sleep(0.2)
            buf += s.read(4096).decode(errors="replace")
            break
    s.close()
    buf = scrub(buf, secrets)
    if a.start and a.start in buf:
        buf = buf[buf.rfind(a.start):] if a.last else buf[buf.find(a.start):]
    if a.end and a.end in buf:
        buf = buf[: buf.find(a.end) + len(a.end)]
    print(buf)
    return buf


# ---------------------------------------------------------------- server oracle

def aux_db() -> sqlite3.Connection:
    return sqlite3.connect(f"file:{PB_DATA / 'auxiliary.db'}?mode=ro", uri=True)


def data_db() -> sqlite3.Connection:
    return sqlite3.connect(f"file:{PB_DATA / 'data.db'}?mode=ro", uri=True)


def query_logs(since: str, path: str, lan: bool) -> list[tuple]:
    # Git Bash rewrites a leading "/api/..." argument into "C:/Program Files/Git/api/...".
    if "/api/" in path and not path.startswith("/api/"):
        path = path[path.index("/api/"):]
    rows = aux_db().execute(
        """select created, json_extract(data,'$.method'), json_extract(data,'$.url'),
                  json_extract(data,'$.status'), json_extract(data,'$.remoteIP')
           from _logs where created >= ? and json_extract(data,'$.url') like ?
           order by created""", (since, path + "%")).fetchall()
    if lan:
        rows = [r for r in rows if not str(r[4] or "").startswith(("0000:", "127.", "::1"))]
    return rows


def cmd_logs(a) -> list[tuple]:
    rows = query_logs(a.since, a.path, a.lan)
    log(f"{len(rows)} request(s) on {a.path} since {a.since}{' from the LAN' if a.lan else ''}")
    for r in rows:
        print(f"  {r[0][11:19]} {r[1]} {r[2][:70]} {r[3]} {r[4]}")
    return rows


def cmd_points(a) -> None:
    con = data_db()
    q = """select p.created, f.`key`, p.from_dev, p.num, p.str from iot_points p
           join iot_feeds f on f.id = p.feed where p.created >= ?"""
    args: list = [a.since]
    if a.feed:
        q += " and f.`key` = ?"
        args.append(a.feed)
    rows = con.execute(q + " order by p.created", args).fetchall()
    log(f"{len(rows)} point(s) since {a.since}")
    by_dev: dict[str, int] = {}
    for r in rows:
        by_dev[r[2]] = by_dev.get(r[2], 0) + 1
    for dev, n in by_dev.items():
        print(f"  dev {dev}: {n}")


# ---------------------------------------------------------------- run

def cmd_run(a) -> None:
    since = utc_now_iso()
    hexfile = cmd_build(a)
    a.hex = str(hexfile)
    cmd_flash(a)
    trace = cmd_trace(a) if (a.end or a.trace_for) else ""
    if a.trace_for and not a.end:
        time.sleep(a.trace_for)
    failed = []
    for text in a.expect or []:
        if text not in trace:
            failed.append(f"trace lacks {text!r}")
    if a.expect_ingest is not None:
        a.since, a.path, a.lan = since, "/api/iot/v1/ingest", True
        rows = cmd_logs(a)
        ok = [r for r in rows if r[3] == 200]
        if len(ok) < a.expect_ingest:
            failed.append(f"expected >= {a.expect_ingest} ingest 200s from the LAN, got {len(ok)}")
    if failed:
        die("; ".join(failed), code=1)
    log("run OK")


# ---------------------------------------------------------------- cli

def main() -> None:
    # Windows consoles default to cp1252; traces and messages are UTF-8.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def build_opts(sp):
        sp.add_argument("program")
        sp.add_argument("--variant", default="v3", choices=["v1", "v2", "v3"])
        sp.add_argument("--name")
        sp.add_argument("--no-ext", action="store_true", help="build without the iot extension")
        sp.add_argument("--dep", action="append", help="extra dependency name=spec")
        sp.add_argument("--var", action="append", help="program placeholder KEY=VALUE ($KEY in the source)")

    def flash_opts(sp):
        sp.add_argument("--drive")
        sp.add_argument("--timeout", type=int, default=45)

    def trace_opts(sp):
        sp.add_argument("--port")
        sp.add_argument("--start")
        sp.add_argument("--end")
        sp.add_argument("--last", action="store_true", help="keep the last start marker, not the first")
        sp.add_argument("--reset", action="store_true", help="reset the target via serial break first")

    sp = sub.add_parser("build"); build_opts(sp); sp.set_defaults(fn=cmd_build)
    sp = sub.add_parser("flash"); sp.add_argument("hex"); flash_opts(sp); sp.set_defaults(fn=cmd_flash)
    sp = sub.add_parser("trace"); trace_opts(sp); sp.add_argument("--timeout", type=int, default=60)
    sp.set_defaults(fn=cmd_trace)
    sp = sub.add_parser("logs")
    sp.add_argument("--since", default=utc_now_iso())
    sp.add_argument("--path", default="/api/iot/v1/")
    sp.add_argument("--lan", action="store_true")
    sp.set_defaults(fn=cmd_logs)
    sp = sub.add_parser("points")
    sp.add_argument("--since", default=utc_now_iso())
    sp.add_argument("--feed")
    sp.set_defaults(fn=cmd_points)
    sp = sub.add_parser("run"); build_opts(sp); flash_opts(sp); trace_opts(sp)
    sp.add_argument("--trace-for", type=int, default=0, help="seconds to wait when not tracing to a marker")
    sp.add_argument("--trace-timeout", type=int, default=90)
    sp.add_argument("--expect", action="append")
    sp.add_argument("--expect-ingest", type=int)
    sp.set_defaults(fn=cmd_run)

    a = p.parse_args()
    if a.cmd == "run" and not hasattr(a, "hex"):
        a.hex = None
    a.fn(a)


if __name__ == "__main__":
    main()
