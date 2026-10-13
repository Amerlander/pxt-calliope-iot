#!/usr/bin/env python3
"""Oracle for programs/wifi-core.ts: every soak_n value 1..N exactly once in iot_points.

  python tools/hil/soakcheck.py [--dev 2656000046] [--since "2026-10-13 12:00:00"]
"""
import argparse, sqlite3, datetime as dt
from pathlib import Path

DB = Path(__file__).resolve().parents[4] / "calliope-campus" / "pocketbase" / "pb_data" / "data.db"

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dev", default="2656000046")
    p.add_argument("--since", default=(dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)).strftime("%Y-%m-%d %H:%M:%S"))
    a = p.parse_args()
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = c.execute("""select p.num, p.created, p.ts from iot_points p join iot_feeds f on f.id=p.feed
        where f.key='soak_n' and p.from_dev=? and p.created >= ? order by p.created""", (a.dev, a.since)).fetchall()
    vals = [int(r[0]) for r in rows]
    if not vals:
        print("no soak_n points"); return
    # A new run starts again at 1: split into runs at every drop.
    runs, cur = [], [vals[0]]
    for v in vals[1:]:
        if v < cur[-1] and v <= 2:
            runs.append(cur); cur = [v]
        else:
            cur.append(v)
    runs.append(cur)
    for i, run in enumerate(runs, 1):
        top = max(run)
        seen = {}
        for v in run: seen[v] = seen.get(v, 0) + 1
        missing = [v for v in range(1, top + 1) if v not in seen]
        dups = sorted(v for v, k in seen.items() if k > 1)
        order = sum(1 for x, y in zip(run, run[1:]) if y < x)
        print(f"run {i}: values 1..{top}, points {len(run)}, missing {len(missing)} {missing[:10]}, "
              f"duplicates {len(dups)} {dups[:10]}, out-of-order {order}")

if __name__ == "__main__":
    main()
