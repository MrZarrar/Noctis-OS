# glycolens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone Python CLI that pulls t:slim X2 + G7 data from Tandem Source weekly, finds dosing and behaviour patterns with deterministic rules, proposes small guarded setting changes, tracks whether applied changes helped, and writes a `report.json` that Noctis will read.

**Architecture:** adapters (Tandem Source via `tconnectsync`, Glooko zip drop folder) → normalised `Data` → SQLite store (idempotent) → pure rule functions → guardrails → report (JSON + optional Vault Markdown) with an optional Qwen summary gated by a number check. No Noctis code in this repo; Noctis integration is **Plan 2**, written when this plan is done, against the `report.json` contract in Task 13.

**Tech Stack:** Python ≥ 3.12 (home PC has 3.14), stdlib (`sqlite3`, `statistics`, `tomllib`, `urllib`, `zipfile`, `csv`), `tconnectsync` ≥ 2, `keyring`, `pytest`.

**Spec:** `docs/superpowers/specs/2026-10-15-glycolens-design.md` (Noctis-OS repo; copied into glycolens in Task 1).

## Global Constraints

- Repo: `C:\Users\mmush\Documents\glycolens` (sibling of `Jarvis`), package at `src/glycolens/`, tests in `tests/`.
- Dependencies: only `tconnectsync>=2`, `keyring>=25`; dev: `pytest>=8`. No pandas, no numpy, no openai SDK.
- Units: glucose in **mmol/L** everywhere inside glycolens (`MG_PER_MMOL = 18.0182`); insulin in U; basal in U/h; carb ratio in g/U; ISF in mmol/L per U.
- Time: **naive local pump time** everywhere (no tz-aware datetimes).
- Health data is never committed: `tests/private/` and everything under `~/.glycolens/` stay out of git. Committed fixtures are synthetic or fabricated.
- Vault writing is **off by default** (`vault` unset in config).
- glycolens never imports Noctis code.
- Thresholds are module constants named in this plan; no config knobs for them.
- TDD per task: failing test → red → minimal code → green → commit.
- Commit after every task. Creating the GitHub remote needs the owner's OK (public vs private) before the first push.
- Owner runs anything needing his credentials or real data (Tasks 1, 11 real check, 16).

## Spec deviations (owner approves with this plan)

1. **Windows** are fixed blocks from config (defaults below); the owner edits them to match his pump segments. Current carb ratio / ISF are read from each bolus's calculator record (`LidBolusRequestedMsg1/2`), so no settings-profile parsing is needed.
2. **Carb-ratio "too strong" (lows) triggers at ≥ 30% of meals** (min 2), not 70%: lows should need less evidence than highs.
3. **Outcome metric** is the window's TIR/TBR before vs after (one metric for every setting), not a per-rule metric.
4. **Analysis covers the last 14 days** of data each run (more qualifying events per window).
5. **Sleep mode** is not ingested: no rule uses it.

## Review Focus

1. **Noctis reads `report.json` while `run` is writing it** → reader sees the old or new file, never a partial one (Task 13: atomic replace test).
2. **`glycolens run` twice in one week** → no duplicate suggestions, an "applied" status survives (Task 15: rerun test).
3. **`mark-applied` with a mistyped id, or on an already-applied suggestion** → clear message, exit 2 / no change (Task 15).
4. **First ever run with Tandem login failing** → exits 1 with the reason, writes no report (Task 15).
5. **CGM gap across the 4-hour point of a meal** (sensor warm-up) → that meal is skipped, not scored from a far-away reading (Task 5).

---

### Task 1: Repo, environment and Tandem Source spike (owner-assisted)

Proves the riskiest assumption before any analysis code exists. **Gate:** if login or event retrieval fails, stop and re-plan ingestion around the Glooko drop folder.

**Files:**
- Create: `pyproject.toml`, `.gitignore`, `README.md`, `docs/design.md` (copy of the spec), `scripts/spike_tandem.py`, `SPIKE.md`, `src/glycolens/__init__.py`, `tests/test_smoke.py`

**Interfaces:**
- Produces: installed package `glycolens`; `SPIKE.md` answers used by Task 11 (`_ts`, `AUTO_BOLUS`, `CARB_RATIO_SCALE`, ISF units, cannula status).

- [ ] **Step 1: Create the repo skeleton**

```powershell
New-Item -ItemType Directory -Force C:\Users\mmush\Documents\glycolens\src\glycolens, C:\Users\mmush\Documents\glycolens\tests, C:\Users\mmush\Documents\glycolens\scripts, C:\Users\mmush\Documents\glycolens\docs
git -C C:\Users\mmush\Documents\glycolens init -b main
Copy-Item C:\Users\mmush\Documents\Jarvis\Noctis-OS\docs\superpowers\specs\2026-10-15-glycolens-design.md C:\Users\mmush\Documents\glycolens\docs\design.md
```

`pyproject.toml`:

```toml
[project]
name = "glycolens"
version = "0.1.0"
description = "Weekly pattern finder for t:slim X2 + Dexcom G7 data"
requires-python = ">=3.12"
dependencies = ["tconnectsync>=2", "keyring>=25"]

[project.optional-dependencies]
dev = ["pytest>=8"]

[project.scripts]
glycolens = "glycolens.cli:main"

[build-system]
requires = ["setuptools>=69"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
pythonpath = ["src", "tests"]
```

`.gitignore`:

```
__pycache__/
*.egg-info/
.venv/
.pytest_cache/
tests/private/
*.db
```

`src/glycolens/__init__.py`:

```python
"""glycolens: weekly pattern finder for t:slim X2 + Dexcom G7 data."""
```

`tests/test_smoke.py`:

```python
import glycolens


def test_package_imports():
    assert glycolens.__doc__
```

`README.md`:

```markdown
# glycolens

Weekly pattern finder for my own t:slim X2 + Dexcom G7 data. Personal, non-commercial, not medical
advice. Design: `docs/design.md`.
```

- [ ] **Step 2: Install and check the environment works under Smart App Control**

```powershell
cd C:\Users\mmush\Documents\glycolens
py -3.14 -m venv .venv
.\.venv\Scripts\python -m pip install -e ".[dev]"
.\.venv\Scripts\python -m pytest -q
```

Expected: `1 passed`. If Smart App Control blocks `.venv\Scripts\python.exe`, fall back to the no-venv interpreter used by the MCP servers (`%LOCALAPPDATA%\Programs\Python\Python314\python.exe -m pip install --user -e ".[dev]"`) and record which one works in `SPIKE.md`. Every later `python` command in this plan means that interpreter.

- [ ] **Step 3: Write the spike script**

`scripts/spike_tandem.py`:

```python
"""One-off spike: log in to Tandem Source and dump the event shapes glycolens needs.

Output is private health data and goes to tests/private/ (git-ignored).
Usage: python scripts/spike_tandem.py [EU|US]
"""
import getpass
import json
import sys
from collections import Counter
from datetime import date, timedelta
from pathlib import Path

from tconnectsync.api.tandemsource import TandemSourceApi

WANT = {
    "LidCgmDataG7", "LidBolusRequestedMsg1", "LidBolusRequestedMsg2", "LidBolusCompleted",
    "LidBasalDelivery", "LidCannulaFilled", "LidAaUserModeChange",
}


def fields(e):
    return {k: repr(getattr(e, k)) for k in dir(e) if not k.startswith("_") and not callable(getattr(e, k))}


def main():
    region = sys.argv[1] if len(sys.argv) > 1 else "EU"
    api = TandemSourceApi(input("Tandem Source email: "), getpass.getpass("Password: "), region)
    pumps = api.get_pumper()["pumps"]
    print("pumps:", len(pumps), "keys:", sorted(pumps[0]))
    end = date.today()
    events = list(api.pump_events(pumps[0]["assignmentId"], min_date=(end - timedelta(days=3)).isoformat(),
                                  max_date=end.isoformat(), fetch_all_event_types=True))
    print(Counter(type(e).__name__ for e in events).most_common(40))
    samples = {}
    for e in events:
        name = type(e).__name__
        if name in WANT and name not in samples:
            samples[name] = fields(e)
    print("\nBoluses (compare with the t:slim app history to spot Control-IQ auto-boluses):")
    for e in events:
        name = type(e).__name__
        if name == "LidBolusRequestedMsg1":
            print(name, e.bolusId, e.bolusTypeRaw, e.carbAmount, e.carbRatioRaw)
        elif name == "LidBolusCompleted":
            print(name, e.bolusId, e.insulinDelivered)
    out = Path("tests/private")
    out.mkdir(parents=True, exist_ok=True)
    (out / "tandem_samples.json").write_text(json.dumps(samples, indent=2))
    print("\nwrote tests/private/tandem_samples.json")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Owner runs the spike**

```powershell
python scripts\spike_tandem.py EU
```

Expected: a pump count of 1, an event-type histogram containing `LidCgmDataG7`, `LidBolusCompleted`, `LidBasalDelivery`, and `tests/private/tandem_samples.json` written. If login fails with `EU`, try `US` once, then stop (gate).

- [ ] **Step 5: Record answers in `SPIKE.md` (no glucose or dose values in it)**

`SPIKE.md` must answer each line:

```markdown
# Spike results (YYYY-MM-DD)

- Interpreter that works: .venv | no-venv Python 3.14
- Region that logs in: EU | US
- Pumps returned: N
- Timestamp attribute on typed events, and is it local pump time? (e.g. `eventTimestamp`, arrow, `.naive` matches the app's clock)
- `carbRatioRaw` scale (e.g. 10000 → 10 g/U means scale 1000)
- `LidBolusRequestedMsg2.isf` unit (mg/dL per U expected)
- How a Control-IQ auto-bolus appears (no Msg1? a `bolusTypeRaw` bit? which value?)
- `LidCannulaFilled.completionStatusRaw` value on a successful fill
- `LidAaUserModeChange` present when exercise mode is used? (yes/no)
```

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml .gitignore README.md docs/design.md scripts/spike_tandem.py SPIKE.md src tests/test_smoke.py
git commit -m "chore: scaffold glycolens and record Tandem Source spike"
```

---

### Task 2: Data model and store

**Files:**
- Create: `src/glycolens/model.py`, `src/glycolens/store.py`
- Test: `tests/test_store.py`

**Interfaces:**
- Produces:
  - `model.MG_PER_MMOL: float`
  - `model.Glucose(ts: datetime, mmol: float)`, `model.Bolus(ts, units: float, carbs_g: float, kind: Literal["meal","correction","auto"], carb_ratio: float, isf: float)`, `model.Basal(ts, programmed: float, delivered: float)`, `model.Event(ts, kind: Literal["site_change","exercise_start","exercise_end"])`, `model.Data(glucose, boluses, basal, events)` (lists, default empty)
  - `store.open_store(path: Path) -> sqlite3.Connection` (row_factory = `sqlite3.Row`)
  - `store.save(conn, data: Data) -> None`, `store.load(conn, start: datetime, end: datetime) -> Data`, `store.latest_glucose(conn) -> datetime | None`
  - Suggestion functions are added in Task 10.

- [ ] **Step 1: Write the failing tests**

`tests/test_store.py`:

```python
from datetime import datetime, timedelta

from glycolens import store
from glycolens.model import Basal, Bolus, Data, Event, Glucose

T = datetime(2026, 1, 5, 7, 0)


def sample():
    return Data(
        glucose=[Glucose(T, 6.5), Glucose(T + timedelta(minutes=5), 6.8)],
        boluses=[Bolus(T, 4.5, 45.0, "meal", 10.0, 2.0)],
        basal=[Basal(T, 0.8, 1.1)],
        events=[Event(T, "site_change")],
    )


def test_save_then_load_round_trips(tmp_path):
    conn = store.open_store(tmp_path / "g.db")
    store.save(conn, sample())
    got = store.load(conn, T - timedelta(hours=1), T + timedelta(hours=1))
    assert got.glucose == sample().glucose
    assert got.boluses == sample().boluses
    assert got.basal == sample().basal
    assert got.events == sample().events


def test_saving_twice_does_not_duplicate(tmp_path):
    conn = store.open_store(tmp_path / "g.db")
    store.save(conn, sample())
    store.save(conn, sample())
    got = store.load(conn, T - timedelta(hours=1), T + timedelta(hours=1))
    assert len(got.glucose) == 2 and len(got.boluses) == 1 and len(got.events) == 1


def test_second_reading_in_same_five_minutes_is_ignored(tmp_path):
    # Two sources (or a DST fall-back hour) can report the same 5-minute slot; first one wins.
    conn = store.open_store(tmp_path / "g.db")
    store.save(conn, Data(glucose=[Glucose(T, 6.5)]))
    store.save(conn, Data(glucose=[Glucose(T + timedelta(minutes=2), 9.9)]))
    got = store.load(conn, T - timedelta(hours=1), T + timedelta(hours=1))
    assert got.glucose == [Glucose(T, 6.5)]


def test_latest_glucose(tmp_path):
    conn = store.open_store(tmp_path / "g.db")
    assert store.latest_glucose(conn) is None
    store.save(conn, sample())
    assert store.latest_glucose(conn) == T + timedelta(minutes=5)


def test_load_includes_the_basal_rate_active_before_start(tmp_path):
    conn = store.open_store(tmp_path / "g.db")
    store.save(conn, sample())
    got = store.load(conn, T + timedelta(hours=2), T + timedelta(hours=3))
    assert got.basal == [Basal(T, 0.8, 1.1)]
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_store.py -q`
Expected: FAIL with `ImportError` / `ModuleNotFoundError: glycolens.model`.

- [ ] **Step 3: Implement**

`src/glycolens/model.py`:

```python
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

MG_PER_MMOL = 18.0182

BolusKind = Literal["meal", "correction", "auto"]
EventKind = Literal["site_change", "exercise_start", "exercise_end"]


@dataclass(frozen=True)
class Glucose:
    ts: datetime
    mmol: float


@dataclass(frozen=True)
class Bolus:
    ts: datetime
    units: float
    carbs_g: float
    kind: BolusKind
    carb_ratio: float  # g/U used by the bolus calculator, 0 if unknown
    isf: float  # mmol/L per U used by the bolus calculator, 0 if unknown


@dataclass(frozen=True)
class Basal:
    """A basal rate in force from `ts` until the next record."""

    ts: datetime
    programmed: float  # U/h from the profile
    delivered: float  # U/h actually commanded (Control-IQ, temp rate, suspend)


@dataclass(frozen=True)
class Event:
    ts: datetime
    kind: EventKind


@dataclass
class Data:
    glucose: list[Glucose] = field(default_factory=list)
    boluses: list[Bolus] = field(default_factory=list)
    basal: list[Basal] = field(default_factory=list)
    events: list[Event] = field(default_factory=list)
```

`src/glycolens/store.py`:

```python
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from glycolens.model import Basal, Bolus, Data, Event, Glucose

SCHEMA = """
create table if not exists glucose(bucket text primary key, ts text not null, mmol real not null);
create table if not exists bolus(ts text not null, kind text not null, units real not null,
  carbs_g real not null, carb_ratio real not null, isf real not null, primary key (ts, kind));
create table if not exists basal(ts text primary key, programmed real not null, delivered real not null);
create table if not exists event(ts text not null, kind text not null, primary key (ts, kind));
"""


def open_store(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def iso(ts: datetime) -> str:
    return ts.isoformat(timespec="seconds")


def _bucket(ts: datetime) -> str:
    return iso(ts.replace(minute=ts.minute - ts.minute % 5, second=0, microsecond=0))


def save(conn: sqlite3.Connection, data: Data) -> None:
    with conn:
        conn.executemany("insert or ignore into glucose values (?, ?, ?)",
                         [(_bucket(g.ts), iso(g.ts), g.mmol) for g in data.glucose])
        conn.executemany("insert or replace into bolus values (?, ?, ?, ?, ?, ?)",
                         [(iso(b.ts), b.kind, b.units, b.carbs_g, b.carb_ratio, b.isf) for b in data.boluses])
        conn.executemany("insert or replace into basal values (?, ?, ?)",
                         [(iso(b.ts), b.programmed, b.delivered) for b in data.basal])
        conn.executemany("insert or ignore into event values (?, ?)", [(iso(e.ts), e.kind) for e in data.events])


def load(conn: sqlite3.Connection, start: datetime, end: datetime) -> Data:
    def rows(sql, a=start):
        return conn.execute(sql, (iso(a), iso(end))).fetchall()

    when = datetime.fromisoformat
    # ponytail: basal looks back a day for the rate already in force at `start`; a rate older than a
    # day is missed. Upgrade: select the last record before `start` explicitly.
    return Data(
        glucose=[Glucose(when(r["ts"]), r["mmol"])
                 for r in rows("select ts, mmol from glucose where ts >= ? and ts < ? order by ts")],
        boluses=[Bolus(when(r["ts"]), r["units"], r["carbs_g"], r["kind"], r["carb_ratio"], r["isf"])
                 for r in rows("select * from bolus where ts >= ? and ts < ? order by ts")],
        basal=[Basal(when(r["ts"]), r["programmed"], r["delivered"])
               for r in rows("select * from basal where ts >= ? and ts < ? order by ts", start - timedelta(days=1))],
        events=[Event(when(r["ts"]), r["kind"])
                for r in rows("select * from event where ts >= ? and ts < ? order by ts")],
    )


def latest_glucose(conn: sqlite3.Connection) -> datetime | None:
    ts = conn.execute("select max(ts) from glucose").fetchone()[0]
    return None if ts is None else datetime.fromisoformat(ts)
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest tests/test_store.py -q`
Expected: `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/glycolens/model.py src/glycolens/store.py tests/test_store.py
git commit -m "feat: normalised data model and idempotent SQLite store"
```

---

### Task 3: Series, windows and baseline statistics

**Files:**
- Create: `src/glycolens/series.py`, `src/glycolens/windows.py`, `src/glycolens/stats.py`
- Test: `tests/test_stats.py`

**Interfaces:**
- Consumes: `model.Glucose`, `model.MG_PER_MMOL`
- Produces:
  - `series.Series(glucose: list[Glucose])` with `.ts: list[datetime]`, `.v: list[float]`, `.at(t, tol=timedelta(minutes=10)) -> float | None`, `.between(a, b) -> list[float]` (a ≤ ts < b), `.items(a, b) -> list[tuple[datetime, float]]`
  - `windows.Window(name: str, start: int, end: int)` (minutes of day, end exclusive, `.contains(ts) -> bool`), `windows.DEFAULT_WINDOWS: tuple[Window, ...]`, `windows.window_of(ts, windows) -> Window`, `windows.parse_windows(rows: list[dict]) -> tuple[Window, ...]`
  - `stats.summary(values: list[float], minutes: float) -> dict` with keys `coverage, mean, tir, tbr, tbr_severe, tar, tar_severe, gmi, cv, min` (all but coverage `None` when empty), `stats.window_summary(series, window, start, end) -> dict`, `stats.agp(series) -> list[dict]` (24 rows: `hour, p5, p25, p50, p75, p95`)

- [ ] **Step 1: Write the failing tests**

`tests/test_stats.py`:

```python
from datetime import datetime, timedelta

import pytest

from glycolens.model import Glucose
from glycolens.series import Series
from glycolens.stats import agp, summary, window_summary
from glycolens.windows import DEFAULT_WINDOWS, Window, parse_windows, window_of

T = datetime(2026, 1, 5, 7, 0)


def test_summary_numbers():
    s = summary([3.0, 5.0, 11.0, 15.0], minutes=20)
    assert s == {"coverage": 1.0, "mean": 8.5, "tir": 25.0, "tbr": 25.0, "tbr_severe": 0.0,
                 "tar": 50.0, "tar_severe": 25.0, "gmi": 7.0, "cv": 56.1, "min": 3.0}


def test_summary_of_nothing_has_zero_coverage():
    s = summary([], minutes=60)
    assert s["coverage"] == 0.0 and s["mean"] is None


def test_series_at_finds_nearest_within_tolerance():
    s = Series([Glucose(T, 6.0), Glucose(T + timedelta(minutes=5), 7.0)])
    assert s.at(T + timedelta(minutes=4)) == 7.0
    assert s.at(T + timedelta(minutes=30)) is None


def test_series_tolerates_duplicate_timestamps():
    s = Series([Glucose(T, 6.0), Glucose(T, 6.1)])
    assert s.at(T) in (6.0, 6.1)


def test_window_of_and_contains():
    assert window_of(T, DEFAULT_WINDOWS).name == "breakfast"
    assert window_of(T.replace(hour=23, minute=59), DEFAULT_WINDOWS).name == "late"


def test_parse_windows_rejects_gaps():
    with pytest.raises(ValueError):
        parse_windows([{"name": "a", "start": "00:00", "end": "06:00"},
                       {"name": "b", "start": "07:00", "end": "24:00"}])
    assert parse_windows([{"name": "all", "start": "00:00", "end": "24:00"}]) == (Window("all", 0, 1440),)


def test_window_summary_and_agp_on_a_flat_day():
    day = [Glucose(T.replace(hour=0) + timedelta(minutes=5 * i), 6.5) for i in range(288)]
    s = Series(day)
    start = T.replace(hour=0)
    breakfast = next(w for w in DEFAULT_WINDOWS if w.name == "breakfast")
    ws = window_summary(s, breakfast, start, start + timedelta(days=1))
    assert ws["coverage"] == 1.0 and ws["tir"] == 100.0
    rows = agp(s)
    assert len(rows) == 24 and rows[7]["p50"] == 6.5
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_stats.py -q`
Expected: FAIL with `ModuleNotFoundError: glycolens.series`.

- [ ] **Step 3: Implement**

`src/glycolens/series.py`:

```python
from bisect import bisect_left
from datetime import datetime, timedelta

from glycolens.model import Glucose


class Series:
    """Glucose readings sorted by time, with nearest-reading lookup."""

    def __init__(self, glucose: list[Glucose]):
        pts = sorted((g.ts, g.mmol) for g in glucose)
        self.ts = [t for t, _ in pts]
        self.v = [v for _, v in pts]

    def at(self, t: datetime, tol: timedelta = timedelta(minutes=10)) -> float | None:
        i = bisect_left(self.ts, t)
        near = [j for j in (i - 1, i) if 0 <= j < len(self.ts) and abs(self.ts[j] - t) <= tol]
        return self.v[min(near, key=lambda j: abs(self.ts[j] - t))] if near else None

    def between(self, a: datetime, b: datetime) -> list[float]:
        return self.v[bisect_left(self.ts, a):bisect_left(self.ts, b)]

    def items(self, a: datetime, b: datetime) -> list[tuple[datetime, float]]:
        i, j = bisect_left(self.ts, a), bisect_left(self.ts, b)
        return list(zip(self.ts[i:j], self.v[i:j]))
```

`src/glycolens/windows.py`:

```python
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Window:
    name: str
    start: int  # minute of day, inclusive
    end: int  # minute of day, exclusive (1440 = midnight)

    def contains(self, ts: datetime) -> bool:
        return self.start <= ts.hour * 60 + ts.minute < self.end


DEFAULT_WINDOWS = (
    Window("overnight", 0, 360),
    Window("breakfast", 360, 600),
    Window("lunch", 600, 840),
    Window("afternoon", 840, 1080),
    Window("dinner", 1080, 1320),
    Window("late", 1320, 1440),
)


def window_of(ts: datetime, windows) -> Window:
    return next(w for w in windows if w.contains(ts))


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def parse_windows(rows: list[dict]) -> tuple[Window, ...]:
    out = tuple(Window(r["name"], _minutes(r["start"]), _minutes(r["end"])) for r in rows)
    edges = [0] + [w.end for w in out]
    if [w.start for w in out] != edges[:-1] or edges[-1] != 1440:
        raise ValueError("windows must run back to back from 00:00 to 24:00")
    return out
```

`src/glycolens/stats.py`:

```python
from collections import defaultdict
from datetime import datetime, timedelta
from statistics import fmean, pstdev, quantiles

from glycolens.model import MG_PER_MMOL
from glycolens.series import Series
from glycolens.windows import Window

EMPTY = {"mean": None, "tir": None, "tbr": None, "tbr_severe": None, "tar": None,
         "tar_severe": None, "gmi": None, "cv": None, "min": None}


def summary(values: list[float], minutes: float) -> dict:
    if not values:
        return {"coverage": 0.0, **EMPTY}
    n, mean = len(values), fmean(values)

    def pct(k):
        return round(100 * k / n, 1)

    return {
        "coverage": round(min(1.0, n / max(minutes / 5, 1)), 3),
        "mean": round(mean, 1),
        "tir": pct(sum(3.9 <= v <= 10.0 for v in values)),
        "tbr": pct(sum(v < 3.9 for v in values)),
        "tbr_severe": pct(sum(v < 3.0 for v in values)),
        "tar": pct(sum(v > 10.0 for v in values)),
        "tar_severe": pct(sum(v > 13.9 for v in values)),
        "gmi": round(3.31 + 0.02392 * mean * MG_PER_MMOL, 1),
        "cv": round(pstdev(values) / mean * 100, 1),
        "min": round(min(values), 1),
    }


def window_summary(series: Series, window: Window, start: datetime, end: datetime) -> dict:
    values = [v for t, v in series.items(start, end) if window.contains(t)]
    return summary(values, (end - start) / timedelta(days=1) * (window.end - window.start))


def agp(series: Series) -> list[dict]:
    by_hour = defaultdict(list)
    for t, v in zip(series.ts, series.v):
        by_hour[t.hour].append(v)
    rows = []
    for h in range(24):
        vs = by_hour[h]
        if len(vs) < 2:
            rows.append({"hour": h, "p5": None, "p25": None, "p50": None, "p75": None, "p95": None})
            continue
        q = quantiles(vs, n=20, method="inclusive")
        rows.append({"hour": h, "p5": round(q[0], 1), "p25": round(q[4], 1), "p50": round(q[9], 1),
                     "p75": round(q[14], 1), "p95": round(q[18], 1)})
    return rows
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest tests/test_stats.py -q`
Expected: `7 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/glycolens/series.py src/glycolens/windows.py src/glycolens/stats.py tests/test_stats.py
git commit -m "feat: glucose series, time windows and baseline statistics"
```

---

### Task 4: Synthetic fixture weeks

Every rule test uses these. Each fixture is 14 days on a 5-minute grid with one injected fault; `clean` has none.

**Files:**
- Create: `tests/synth.py`
- Test: `tests/test_synth.py`

**Interfaces:**
- Consumes: `model.*`
- Produces: `synth.START = datetime(2026, 1, 5)`, `synth.DAYS = 14`, `synth.FAULTS: tuple[str, ...]`, `synth.make(fault: str | None = None) -> Data`

Daily schedule (all fixtures): breakfast 07:00 (45 g), lunch 12:00 (60 g), dinner 18:30 (70 g) on **odd** days only; on **even** days a slow rise 16:00→19:00 and a 1.0 U correction at 19:00; site change at 08:00 every 3rd day; basal 0.8 U/h every hour. Every bolus records carb ratio 10 g/U and ISF 2.0 mmol/L/U.

- [ ] **Step 1: Write the failing test**

`tests/test_synth.py`:

```python
from datetime import timedelta

import synth
from glycolens.series import Series
from glycolens.stats import summary


def test_clean_fixture_is_complete_and_in_range():
    d = synth.make()
    assert len(d.glucose) == synth.DAYS * 288
    s = summary([g.mmol for g in d.glucose], synth.DAYS * 1440)
    assert s["coverage"] == 1.0 and s["tbr"] == 0.0


def test_weak_breakfast_ends_three_above_start():
    d = synth.make("weak_breakfast")
    s = Series(d.glucose)
    t = synth.START.replace(hour=7)
    assert round(s.at(t + timedelta(hours=4)) - s.at(t), 1) == 3.0


def test_every_fault_builds():
    for fault in synth.FAULTS:
        assert synth.make(fault).glucose
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest tests/test_synth.py -q`
Expected: FAIL with `ModuleNotFoundError: synth`.

- [ ] **Step 3: Implement**

`tests/synth.py`:

```python
"""Synthetic 14-day datasets with one known, injected fault each.

Shapes are piecewise-linear [(minutes after start, mmol delta)] added to a flat 6.5 baseline.
"""
from datetime import datetime, timedelta

from glycolens.model import Basal, Bolus, Data, Event, Glucose

START = datetime(2026, 1, 5)
DAYS = 14
BASE = 6.5

CLEAN_MEAL = [(0, 0.0), (60, 2.5), (240, 0.5), (300, 0.0)]
WEAK_MEAL = [(0, 0.0), (60, 3.5), (240, 3.0), (420, 0.0)]
LATE_BOLUS_MEAL = [(0, 0.0), (60, 5.0), (240, 0.5), (300, 0.0)]
LOW_MEAL = [(0, 0.0), (45, 1.0), (180, -3.3), (240, -1.5), (330, 0.0)]

FAULTS = ("weak_breakfast", "late_prebolus", "lunch_lows", "strong_isf", "night_basal_low",
          "missed_bolus", "exercise_lows", "site_day3")


def _bump(off: dict, t0: datetime, shape: list[tuple[int, float]]) -> None:
    for (m0, d0), (m1, d1) in zip(shape, shape[1:]):
        for m in range(m0, m1, 5):
            t = t0 + timedelta(minutes=m)
            off[t] = off.get(t, 0.0) + d0 + (d1 - d0) * (m - m0) / (m1 - m0)


def _meal(off, boluses, t, carbs, shape):
    _bump(off, t, shape)
    boluses.append(Bolus(t, carbs / 10, float(carbs), "meal", 10.0, 2.0))


def make(fault: str | None = None) -> Data:
    off, boluses, basal, events = {}, [], [], []
    for day in range(DAYS):
        d = START + timedelta(days=day)
        odd = day % 2 == 1
        breakfast = {"weak_breakfast": WEAK_MEAL, "late_prebolus": LATE_BOLUS_MEAL}.get(fault, CLEAN_MEAL)
        _meal(off, boluses, d.replace(hour=7), 45, breakfast)
        _meal(off, boluses, d.replace(hour=12), 60, LOW_MEAL if fault == "lunch_lows" else CLEAN_MEAL)
        if odd:
            _meal(off, boluses, d.replace(hour=18, minute=30), 70, CLEAN_MEAL)
        else:
            drop = 3.2 if fault == "strong_isf" else 2.0
            _bump(off, d.replace(hour=16), [(0, 0.0), (180, 4.0), (360, 4.0 - drop), (450, 0.0)])
            boluses.append(Bolus(d.replace(hour=19), 1.0, 0.0, "correction", 10.0, 2.0))
        if fault == "missed_bolus" and day in (1, 3, 5):
            _bump(off, d.replace(hour=22, minute=30), [(0, 0.0), (60, 4.0), (120, 0.0)])
        if fault == "exercise_lows" and odd:
            events += [Event(d.replace(hour=21, minute=30), "exercise_start"),
                       Event(d.replace(hour=22, minute=30), "exercise_end")]
            _bump(off, d.replace(hour=22, minute=30), [(0, 0.0), (60, -3.1), (150, 0.0)])
        if fault == "night_basal_low":
            _bump(off, d, [(0, 0.0), (360, 2.0), (420, 0.0)])
        if day % 3 == 0:
            events.append(Event(d.replace(hour=8), "site_change"))
            if fault == "site_day3":
                _bump(off, d.replace(hour=8) + timedelta(hours=48), [(0, 2.0), (1440, 2.0)])
        for h in range(24):
            low_night = fault == "night_basal_low" and h < 6
            basal.append(Basal(d.replace(hour=h), 0.8, 1.12 if low_night else 0.8))
    grid = [START + timedelta(minutes=5 * i) for i in range(DAYS * 288)]
    glucose = [Glucose(t, round(BASE + off.get(t, 0.0), 2)) for t in grid]
    return Data(glucose=glucose, boluses=sorted(boluses, key=lambda b: b.ts), basal=basal,
                events=sorted(events, key=lambda e: e.ts))
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest tests/test_synth.py -q`
Expected: `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add tests/synth.py tests/test_synth.py
git commit -m "test: synthetic fixture weeks with injected dosing faults"
```

---

### Task 5: Meal rules — carb ratio and pre-bolus timing

**Files:**
- Create: `src/glycolens/findings.py`, `src/glycolens/meals.py`
- Test: `tests/test_meals.py`

**Interfaces:**
- Consumes: `Series`, `window_of`, `Data`, `synth`
- Produces:
  - `findings.Finding(rule: str, window: str, direction: str, events: int, hits: int, metric: float, evidence: tuple[str, ...])` — `direction ∈ {"stronger", "weaker", ""}` (stronger = more insulin)
  - `findings.consistent(hits: int, events: int, share: float) -> bool` (hits ≥ 2 and hits/events ≥ share)
  - `findings.user_boluses(data) -> list[Bolus]` (non-`auto`)
  - `findings.exercise_spans(data) -> list[tuple[datetime, datetime]]`
  - `findings.by_window(items, key) -> dict[str, list]` (insertion-ordered grouping)
  - `meals.Meal(ts, window, carbs, start, peak, end, nadir)` with property `low: bool` (nadir < 3.9), `meals.meals(data, series, windows) -> list[Meal]`, `meals.carb_ratio(ms) -> list[Finding]`, `meals.pre_bolus(ms) -> list[Finding]`

- [ ] **Step 1: Write the failing tests**

`tests/test_meals.py`:

```python
from datetime import time

import synth
from glycolens import meals
from glycolens.series import Series
from glycolens.windows import DEFAULT_WINDOWS


def run(data):
    ms = meals.meals(data, Series(data.glucose), DEFAULT_WINDOWS)
    return {(f.rule, f.window, f.direction) for f in meals.carb_ratio(ms) + meals.pre_bolus(ms)}


def test_clean_has_no_meal_findings():
    assert run(synth.make()) == set()


def test_weak_breakfast_asks_for_a_stronger_breakfast_ratio():
    assert run(synth.make("weak_breakfast")) == {("carb_ratio", "breakfast", "stronger")}


def test_late_prebolus_is_timing_not_ratio():
    assert run(synth.make("late_prebolus")) == {("pre_bolus", "breakfast", "")}


def test_lunch_lows_ask_for_a_weaker_lunch_ratio():
    assert run(synth.make("lunch_lows")) == {("carb_ratio", "lunch", "weaker")}


def test_meal_with_no_reading_near_four_hours_is_skipped():
    data = synth.make("weak_breakfast")
    data.glucose = [g for g in data.glucose if not time(10, 45) <= g.ts.time() <= time(11, 15)]
    assert run(data) == set()


def test_finding_carries_evidence():
    data = synth.make("weak_breakfast")
    ms = meals.meals(data, Series(data.glucose), DEFAULT_WINDOWS)
    (f,) = meals.carb_ratio(ms)
    assert f.events == 14 and f.hits == 14 and f.metric == 3.0 and len(f.evidence) == 14
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_meals.py -q`
Expected: FAIL with `ModuleNotFoundError: glycolens.meals`.

- [ ] **Step 3: Implement**

`src/glycolens/findings.py`:

```python
from dataclasses import dataclass
from datetime import datetime, timedelta

from glycolens.model import Bolus, Data


@dataclass(frozen=True)
class Finding:
    rule: str
    window: str
    direction: str  # "stronger" (more insulin), "weaker", or "" for behaviour
    events: int  # qualifying events
    hits: int  # events showing the pattern
    metric: float  # the rule's headline number
    evidence: tuple[str, ...]


def consistent(hits: int, events: int, share: float) -> bool:
    return hits >= 2 and hits / events >= share


def user_boluses(data: Data) -> list[Bolus]:
    return [b for b in data.boluses if b.kind != "auto"]


def exercise_spans(data: Data) -> list[tuple[datetime, datetime]]:
    spans, start = [], None
    for e in sorted(data.events, key=lambda e: e.ts):
        if e.kind == "exercise_start":
            start = e.ts
        elif e.kind == "exercise_end" and start is not None:
            spans.append((start, e.ts))
            start = None
    if start is not None:
        spans.append((start, start + timedelta(hours=2)))  # no end logged: assume 2 h
    return spans


def by_window(items, key) -> dict[str, list]:
    out: dict[str, list] = {}
    for item in items:
        out.setdefault(key(item), []).append(item)
    return out
```

`src/glycolens/meals.py`:

```python
from dataclasses import dataclass
from datetime import datetime, timedelta
from statistics import median

from glycolens.findings import Finding, by_window, consistent, user_boluses
from glycolens.model import Data
from glycolens.series import Series
from glycolens.windows import window_of

HORIZON = timedelta(hours=4)
HIGH_END = 2.0  # mmol/L above start at 4 h
TIMING_PEAK = 4.0  # mmol/L rise within 90 min
HIGH_SHARE = 0.7
LOW_SHARE = 0.3  # lows need less evidence than highs
TIMING_SHARE = 0.5


@dataclass(frozen=True)
class Meal:
    ts: datetime
    window: str
    carbs: float
    start: float
    peak: float
    end: float
    nadir: float  # lowest reading within 4 h

    @property
    def low(self) -> bool:
        return self.nadir < 3.9


def meals(data: Data, series: Series, windows) -> list[Meal]:
    user = user_boluses(data)
    out = []
    for b in user:
        if b.carbs_g <= 0 or any(o is not b and b.ts < o.ts < b.ts + HORIZON for o in user):
            continue
        start, end = series.at(b.ts), series.at(b.ts + HORIZON)
        early = series.between(b.ts, b.ts + timedelta(minutes=90))
        if start is None or end is None or not early:
            continue
        span = series.between(b.ts, b.ts + HORIZON + timedelta(minutes=1))
        out.append(Meal(b.ts, window_of(b.ts, windows).name, b.carbs_g, start, max(early), end, min(span)))
    return out


def is_timing(m: Meal) -> bool:
    return m.peak - m.start >= TIMING_PEAK and abs(m.end - m.start) <= HIGH_END


def _line(m: Meal) -> str:
    return f"{m.ts:%a %d %b %H:%M} {m.carbs:g}g: {m.start:.1f} → peak {m.peak:.1f} → {m.end:.1f} at 4h"


def carb_ratio(ms: list[Meal]) -> list[Finding]:
    out = []
    for window, group in by_window(ms, lambda m: m.window).items():
        rest = [m for m in group if not is_timing(m)]
        lows = [m for m in rest if m.low]
        highs = [m for m in rest if not m.low and m.end - m.start > HIGH_END]
        if rest and consistent(len(lows), len(rest), LOW_SHARE):
            out.append(Finding("carb_ratio", window, "weaker", len(rest), len(lows),
                               round(min(m.nadir for m in lows), 1), tuple(map(_line, lows))))
        elif rest and consistent(len(highs), len(rest), HIGH_SHARE):
            out.append(Finding("carb_ratio", window, "stronger", len(rest), len(highs),
                               round(median(m.end - m.start for m in highs), 1), tuple(map(_line, highs))))
    return out


def pre_bolus(ms: list[Meal]) -> list[Finding]:
    out = []
    for window, group in by_window(ms, lambda m: m.window).items():
        timing = [m for m in group if is_timing(m)]
        if consistent(len(timing), len(group), TIMING_SHARE):
            out.append(Finding("pre_bolus", window, "", len(group), len(timing),
                               round(median(m.peak - m.start for m in timing), 1), tuple(map(_line, timing))))
    return out
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest tests/test_meals.py -q`
Expected: `6 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/glycolens/findings.py src/glycolens/meals.py tests/test_meals.py
git commit -m "feat: carb ratio and pre-bolus timing rules"
```

---

### Task 6: Correction factor (ISF) rule

**Files:**
- Create: `src/glycolens/corrections.py`
- Test: `tests/test_corrections.py`

**Interfaces:**
- Consumes: `Finding`, `consistent`, `user_boluses`, `exercise_spans`, `by_window`, `Series`, `window_of`
- Produces: `corrections.isf(data, series, windows) -> list[Finding]` (metric = median actual/expected drop ratio)

- [ ] **Step 1: Write the failing tests**

`tests/test_corrections.py`:

```python
import synth
from glycolens.corrections import isf
from glycolens.model import Bolus
from glycolens.series import Series
from glycolens.windows import DEFAULT_WINDOWS


def run(data):
    return isf(data, Series(data.glucose), DEFAULT_WINDOWS)


def test_clean_corrections_match_isf():
    assert run(synth.make()) == []


def test_overshooting_corrections_ask_for_a_weaker_isf():
    (f,) = run(synth.make("strong_isf"))
    assert (f.rule, f.window, f.direction, f.events) == ("isf", "dinner", "weaker", 7)
    assert f.metric == 1.6


def test_auto_boluses_are_never_scored_as_corrections():
    data = synth.make("strong_isf")
    data.boluses = [Bolus(b.ts, b.units, b.carbs_g, "auto", b.carb_ratio, b.isf) if b.kind == "correction" else b
                    for b in data.boluses]
    assert run(data) == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_corrections.py -q`
Expected: FAIL with `ModuleNotFoundError: glycolens.corrections`.

- [ ] **Step 3: Implement**

`src/glycolens/corrections.py`:

```python
from datetime import timedelta
from statistics import median

from glycolens.findings import Finding, by_window, consistent, exercise_spans, user_boluses
from glycolens.model import Data
from glycolens.series import Series
from glycolens.windows import window_of

HORIZON = timedelta(hours=3)
NO_CARBS = timedelta(hours=2)
TOO_STRONG = 1.3
TOO_WEAK = 0.7
SHARE = 0.7


def isf(data: Data, series: Series, windows) -> list[Finding]:
    user = user_boluses(data)
    spans = exercise_spans(data)
    scored = []  # (window, ratio, line)
    for b in user:
        if b.kind != "correction" or b.isf <= 0 or b.units <= 0:
            continue
        if any(o.carbs_g > 0 and abs(o.ts - b.ts) <= NO_CARBS for o in user):
            continue
        if any(o is not b and b.ts < o.ts < b.ts + HORIZON for o in user):
            continue
        if any(s <= b.ts <= e for s, e in spans):
            continue
        start, end = series.at(b.ts), series.at(b.ts + HORIZON)
        if start is None or end is None:
            continue
        expected = b.units * b.isf
        ratio = (start - end) / expected
        line = f"{b.ts:%a %d %b %H:%M} {b.units:g}U: {start:.1f} → {end:.1f} (expected −{expected:.1f})"
        scored.append((window_of(b.ts, windows).name, ratio, line))
    out = []
    for window, group in by_window(scored, lambda s: s[0]).items():
        ratios = [r for _, r, _ in group]
        strong = [s for s in group if s[1] > TOO_STRONG]
        weak = [s for s in group if s[1] < TOO_WEAK]
        if consistent(len(strong), len(group), SHARE):
            out.append(Finding("isf", window, "weaker", len(group), len(strong), round(median(ratios), 1),
                               tuple(s[2] for s in strong)))
        elif consistent(len(weak), len(group), SHARE):
            out.append(Finding("isf", window, "stronger", len(group), len(weak), round(median(ratios), 1),
                               tuple(s[2] for s in weak)))
    return out
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest tests/test_corrections.py -q`
Expected: `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/glycolens/corrections.py tests/test_corrections.py
git commit -m "feat: correction factor rule that ignores Control-IQ auto-boluses"
```

---

### Task 7: Basal rule (programmed vs delivered)

**Files:**
- Create: `src/glycolens/basal.py`
- Test: `tests/test_basal.py`

**Interfaces:**
- Consumes: `Finding`, `consistent`, `user_boluses`, `exercise_spans`, `Series`, `Window`
- Produces: `basal.delivered_ratio(records: list[Basal], a, b) -> float | None`, `basal.basal(data, series, windows) -> list[Finding]` (metric = median delivered/programmed ratio)

- [ ] **Step 1: Write the failing tests**

`tests/test_basal.py`:

```python
from datetime import datetime

import synth
from glycolens.basal import basal, delivered_ratio
from glycolens.model import Basal
from glycolens.series import Series
from glycolens.windows import DEFAULT_WINDOWS


def run(data):
    return basal(data, Series(data.glucose), DEFAULT_WINDOWS)


def test_clean_basal_is_quiet():
    assert run(synth.make()) == []


def test_control_iq_pushing_overnight_asks_for_more_basal():
    (f,) = run(synth.make("night_basal_low"))
    assert (f.rule, f.window, f.direction, f.events, f.hits) == ("basal", "overnight", "stronger", 14, 14)
    assert f.metric == 1.4


def test_delivered_ratio_is_time_weighted():
    a = datetime(2026, 1, 5, 0, 0)
    records = [Basal(a.replace(hour=0), 1.0, 2.0), Basal(a.replace(hour=1), 1.0, 1.0)]
    assert delivered_ratio(records, a, a.replace(hour=4)) == 1.25


def test_exercise_nights_are_not_fasting():
    assert run(synth.make("exercise_lows")) == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_basal.py -q`
Expected: FAIL with `ModuleNotFoundError: glycolens.basal`.

- [ ] **Step 3: Implement**

`src/glycolens/basal.py`:

```python
from datetime import datetime, time, timedelta
from statistics import median

from glycolens.findings import Finding, consistent, exercise_spans, user_boluses
from glycolens.model import Basal, Data
from glycolens.series import Series

FAST_BEFORE = timedelta(hours=4)
HIGH_RATIO = 1.25
LOW_RATIO = 0.75
DRIFT = 1.5
SHARE = 0.7


def delivered_ratio(records: list[Basal], a: datetime, b: datetime) -> float | None:
    rs = sorted(records, key=lambda r: r.ts)
    given = planned = 0.0
    for r, nxt in zip(rs, rs[1:] + [None]):
        lo, hi = max(r.ts, a), min(nxt.ts if nxt else b, b)
        if hi <= lo:
            continue
        hours = (hi - lo) / timedelta(hours=1)
        given += r.delivered * hours
        planned += r.programmed * hours
    return round(given / planned, 2) if planned > 0 else None


def basal(data: Data, series: Series, windows) -> list[Finding]:
    user = user_boluses(data)
    spans = exercise_spans(data)
    days = sorted({g.ts.date() for g in data.glucose})
    out = []
    for w in windows:
        under, over, n, ratios = [], [], 0, []
        for d in days:
            a = datetime.combine(d, time()) + timedelta(minutes=w.start)
            b = datetime.combine(d, time()) + timedelta(minutes=w.end)
            if any(a - FAST_BEFORE <= o.ts < b for o in user):
                continue
            if any(s < b and e > a - FAST_BEFORE for s, e in spans):
                continue
            ga, gb, ratio = series.at(a), series.at(b), delivered_ratio(data.basal, a, b)
            if ga is None or gb is None or ratio is None:
                continue
            n += 1
            ratios.append(ratio)
            line = f"{a:%a %d %b} {w.name}: basal ran at {ratio:.0%} of programmed, glucose {ga:.1f} → {gb:.1f}"
            if ratio >= HIGH_RATIO or gb - ga > DRIFT:
                under.append(line)
            elif ratio <= LOW_RATIO or gb - ga < -DRIFT:
                over.append(line)
        if n and consistent(len(over), n, SHARE):
            out.append(Finding("basal", w.name, "weaker", n, len(over), round(median(ratios), 2), tuple(over)))
        elif n and consistent(len(under), n, SHARE):
            out.append(Finding("basal", w.name, "stronger", n, len(under), round(median(ratios), 2), tuple(under)))
    return out
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest tests/test_basal.py -q`
Expected: `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/glycolens/basal.py tests/test_basal.py
git commit -m "feat: basal rule comparing Control-IQ delivery with the programmed profile"
```

---

### Task 8: Behaviour rules, `analyse()` and the cross-trigger matrix

**Files:**
- Create: `src/glycolens/behaviour.py`, `src/glycolens/analyse.py`
- Test: `tests/test_behaviour.py`, `tests/test_matrix.py`

**Interfaces:**
- Consumes: everything from Tasks 5–7
- Produces: `behaviour.missed_bolus(data, series, windows)`, `behaviour.exercise_low(data, series)`, `behaviour.site_age(data, series)` (each `-> list[Finding]`; the last two use window `"all"`); `analyse.analyse(data: Data, windows) -> list[Finding]`

- [ ] **Step 1: Write the failing tests**

`tests/test_behaviour.py`:

```python
import synth
from glycolens import behaviour
from glycolens.series import Series
from glycolens.windows import DEFAULT_WINDOWS


def test_missed_boluses_found_late_evening():
    d = synth.make("missed_bolus")
    (f,) = behaviour.missed_bolus(d, Series(d.glucose), DEFAULT_WINDOWS)
    assert (f.rule, f.window, f.hits) == ("missed_bolus", "late", 3)


def test_exercise_lows_found():
    d = synth.make("exercise_lows")
    (f,) = behaviour.exercise_low(d, Series(d.glucose))
    assert (f.events, f.hits, f.metric) == (7, 7, 3.4)


def test_site_day_three_highs_found():
    d = synth.make("site_day3")
    (f,) = behaviour.site_age(d, Series(d.glucose))
    assert f.metric >= 1.5
```

`tests/test_matrix.py`:

```python
import pytest

import synth
from glycolens.analyse import analyse
from glycolens.windows import DEFAULT_WINDOWS

EXPECTED = {
    None: set(),
    "weak_breakfast": {("carb_ratio", "breakfast", "stronger")},
    "late_prebolus": {("pre_bolus", "breakfast", "")},
    "lunch_lows": {("carb_ratio", "lunch", "weaker")},
    "strong_isf": {("isf", "dinner", "weaker")},
    "night_basal_low": {("basal", "overnight", "stronger")},
    "missed_bolus": {("missed_bolus", "late", "")},
    "exercise_lows": {("exercise_low", "all", "")},
    "site_day3": {("site_age", "all", "")},
}


def test_matrix_covers_every_fault():
    assert set(EXPECTED) - {None} == set(synth.FAULTS)


@pytest.mark.parametrize("fault", list(EXPECTED))
def test_each_fault_triggers_only_its_own_rule(fault):
    got = {(f.rule, f.window, f.direction) for f in analyse(synth.make(fault), DEFAULT_WINDOWS)}
    assert got == EXPECTED[fault]
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_behaviour.py tests/test_matrix.py -q`
Expected: FAIL with `ModuleNotFoundError: glycolens.behaviour`.

- [ ] **Step 3: Implement**

`src/glycolens/behaviour.py`:

```python
from datetime import timedelta
from statistics import fmean

from glycolens.findings import Finding, by_window, consistent, exercise_spans, user_boluses
from glycolens.model import Data
from glycolens.series import Series
from glycolens.windows import window_of

RISE = 3.0  # mmol/L within an hour
RISE_SPAN = timedelta(hours=1)
REFRACTORY = timedelta(hours=3)
AFTER_EXERCISE = timedelta(hours=6)
EXERCISE_SHARE = 0.5
SITE_DIFF = 1.5


def missed_bolus(data: Data, series: Series, windows) -> list[Finding]:
    user = user_boluses(data)
    hits, last = [], None
    for t, v in zip(series.ts, series.v):
        later = series.at(t + RISE_SPAN, tol=timedelta(minutes=5))
        if later is None or later - v < RISE or (last and t - last < REFRACTORY):
            continue
        if any(t - RISE_SPAN <= o.ts <= t + RISE_SPAN for o in user):
            continue
        hits.append((t, v, later))
        last = t
    out = []
    for window, group in by_window(hits, lambda h: window_of(h[0], windows).name).items():
        if len(group) >= 2:
            out.append(Finding("missed_bolus", window, "", len(group), len(group), float(len(group)),
                               tuple(f"{t:%a %d %b %H:%M}: {v:.1f} → {u:.1f} in an hour, no bolus" for t, v, u in group)))
    return out


def exercise_low(data: Data, series: Series) -> list[Finding]:
    sessions = exercise_spans(data)
    lows = []
    for s, e in sessions:
        after = series.between(s, e + AFTER_EXERCISE)
        if after and min(after) < 3.9:
            lows.append((s, min(after)))
    if not consistent(len(lows), len(sessions) or 1, EXERCISE_SHARE):
        return []
    return [Finding("exercise_low", "all", "", len(sessions), len(lows), round(min(m for _, m in lows), 1),
                    tuple(f"{s:%a %d %b %H:%M}: low of {m:.1f} within 6h" for s, m in lows))]


def site_age(data: Data, series: Series) -> list[Finding]:
    changes = sorted(e.ts for e in data.events if e.kind == "site_change")
    early, late = [], []
    for t, v in zip(series.ts, series.v):
        since = [c for c in changes if c <= t]
        if not since:
            continue
        (late if (t - since[-1]) >= timedelta(days=2) else early).append(v)
    if len(late) < 288 or not early:
        return []
    diff = round(fmean(late) - fmean(early), 1)
    if diff < SITE_DIFF:
        return []
    return [Finding("site_age", "all", "", len(changes), len(changes), diff,
                    (f"day 3+ mean {fmean(late):.1f} vs days 1–2 mean {fmean(early):.1f}",))]
```

`src/glycolens/analyse.py`:

```python
from glycolens import basal, behaviour, corrections, meals
from glycolens.findings import Finding
from glycolens.model import Data
from glycolens.series import Series


def analyse(data: Data, windows) -> list[Finding]:
    series = Series(data.glucose)
    ms = meals.meals(data, series, windows)
    return [
        *meals.carb_ratio(ms),
        *meals.pre_bolus(ms),
        *corrections.isf(data, series, windows),
        *basal.basal(data, series, windows),
        *behaviour.missed_bolus(data, series, windows),
        *behaviour.exercise_low(data, series),
        *behaviour.site_age(data, series),
    ]
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest -q`
Expected: all pass (`test_matrix.py`: 10 passed). If a matrix cell fails, fix the **rule**, never the fixture: the fixture timings in Task 4 were chosen so each fault stays out of every other rule's window.

- [ ] **Step 5: Commit**

```bash
git add src/glycolens/behaviour.py src/glycolens/analyse.py tests/test_behaviour.py tests/test_matrix.py
git commit -m "feat: behaviour rules and a cross-trigger matrix over every injected fault"
```

---

### Task 9: Guardrails and suggestions

**Files:**
- Create: `src/glycolens/suggest.py`
- Test: `tests/test_suggest.py`

**Interfaces:**
- Consumes: `Finding`, `user_boluses`, `window_of`, `window_summary`
- Produces:
  - `suggest.Suggestion(id: str, window: str, setting: str, direction: str, current: float, proposed: float, evidence: tuple[str, ...])`
  - `suggest.Watching(window: str, rule: str, reason: str)`
  - `suggest.STEP = 0.10`, `suggest.step(setting, direction, current) -> float`
  - `suggest.current_settings(data, windows) -> dict[tuple[str, str], float]` keyed `(window, setting)`
  - `suggest.decide(findings, window_stats: dict[str, dict], current, measuring: set[str], week_id: str) -> tuple[list[Suggestion], list[Watching]]`

- [ ] **Step 1: Write the failing tests**

`tests/test_suggest.py`:

```python
from datetime import timedelta

import pytest

import synth
from glycolens.analyse import analyse
from glycolens.findings import Finding
from glycolens.series import Series
from glycolens.stats import window_summary
from glycolens.suggest import current_settings, decide, step
from glycolens.windows import DEFAULT_WINDOWS

END = synth.START + timedelta(days=synth.DAYS)


def inputs(fault):
    d = synth.make(fault)
    s = Series(d.glucose)
    ws = {w.name: window_summary(s, w, synth.START, END) for w in DEFAULT_WINDOWS}
    return analyse(d, DEFAULT_WINDOWS), ws, current_settings(d, DEFAULT_WINDOWS)


def f(rule, window, direction, events=10):
    return Finding(rule, window, direction, events, events, 0.0, ("e",))


def test_weak_breakfast_suggests_ten_percent_stronger_ratio():
    findings, ws, cur = inputs("weak_breakfast")
    (s,), watching = decide(findings, ws, cur, set(), "2026-W03")
    assert (s.id, s.setting, s.current, s.proposed) == ("2026-W03-breakfast-carb_ratio", "carb_ratio", 10.0, 9.0)
    assert watching == []


def test_lunch_lows_suggest_weaker_ratio():
    findings, ws, cur = inputs("lunch_lows")
    (s,), _ = decide(findings, ws, cur, set(), "w")
    assert (s.window, s.direction, s.proposed) == ("lunch", "weaker", 11.0)


@pytest.mark.parametrize("lows", [{"tbr": 6.0}, {"min": 2.8}])
def test_lows_win_blocks_a_stronger_change(lows):
    _, ws, cur = inputs(None)
    ws["lunch"] = {**ws["lunch"], **lows}
    sugg, watching = decide([f("carb_ratio", "lunch", "stronger")], ws, cur, set(), "w")
    assert sugg == [] and watching[0].reason == "lows in this window"


def test_too_few_events_only_watches():
    _, ws, cur = inputs(None)
    sugg, watching = decide([f("carb_ratio", "breakfast", "stronger", events=3)], ws, cur, set(), "w")
    assert sugg == [] and "only 3" in watching[0].reason


def test_low_coverage_only_watches():
    _, ws, cur = inputs(None)
    ws["breakfast"] = {**ws["breakfast"], "coverage": 0.5}
    sugg, watching = decide([f("carb_ratio", "breakfast", "stronger")], ws, cur, set(), "w")
    assert sugg == [] and watching[0].reason == "insufficient CGM data"


def test_window_under_measurement_gets_nothing_new():
    _, ws, cur = inputs(None)
    sugg, watching = decide([f("carb_ratio", "breakfast", "stronger")], ws, cur, {"breakfast"}, "w")
    assert sugg == [] and watching[0].reason == "measuring an applied change"


def test_one_change_per_window_and_weaker_goes_first():
    _, ws, cur = inputs(None)
    sugg, watching = decide([f("isf", "dinner", "stronger"), f("carb_ratio", "dinner", "weaker")], ws, cur, set(), "w")
    assert [(s.setting, s.direction) for s in sugg] == [("carb_ratio", "weaker")]
    assert watching[0].reason == "one change per window per week"


def test_unknown_current_setting_only_watches():
    _, ws, _ = inputs(None)
    sugg, watching = decide([f("carb_ratio", "breakfast", "stronger")], ws, {}, set(), "w")
    assert sugg == [] and watching[0].reason == "current setting unknown"


def test_behaviour_findings_never_become_suggestions():
    findings, ws, cur = inputs("late_prebolus")
    assert decide(findings, ws, cur, set(), "w") == ([], [])


@pytest.mark.parametrize("setting,direction,current,expected", [
    ("carb_ratio", "stronger", 10.0, 9.0), ("carb_ratio", "weaker", 10.0, 11.0),
    ("isf", "stronger", 2.0, 1.8), ("isf", "weaker", 2.0, 2.2),
    ("basal", "stronger", 0.8, 0.88), ("basal", "weaker", 0.8, 0.72),
])
def test_step_is_at_most_ten_percent_in_the_right_direction(setting, direction, current, expected):
    assert step(setting, direction, current) == expected
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_suggest.py -q`
Expected: FAIL with `ModuleNotFoundError: glycolens.suggest`.

- [ ] **Step 3: Implement**

`src/glycolens/suggest.py`:

```python
from dataclasses import dataclass
from statistics import median

from glycolens.findings import Finding, user_boluses
from glycolens.model import Data
from glycolens.windows import window_of

SETTINGS = ("carb_ratio", "isf", "basal")
STEP = 0.10
MIN_EVENTS = 4
MIN_COVERAGE = 0.7
LOW_TBR = 4.0  # % below 3.9
SEVERE_MIN = 3.0


@dataclass(frozen=True)
class Suggestion:
    id: str
    window: str
    setting: str
    direction: str
    current: float
    proposed: float
    evidence: tuple[str, ...]


@dataclass(frozen=True)
class Watching:
    window: str
    rule: str
    reason: str


def step(setting: str, direction: str, current: float) -> float:
    # Carb ratio and ISF: a smaller number is more insulin. Basal: a bigger number is.
    up = (direction == "stronger") == (setting == "basal")
    return round(current * (1 + STEP if up else 1 - STEP), 2 if setting == "basal" else 1)


def current_settings(data: Data, windows) -> dict[tuple[str, str], float]:
    cur: dict[tuple[str, str], float] = {}
    for b in sorted(user_boluses(data), key=lambda b: b.ts):
        w = window_of(b.ts, windows).name
        if b.carb_ratio > 0:
            cur[(w, "carb_ratio")] = b.carb_ratio
        if b.isf > 0:
            cur[(w, "isf")] = b.isf
    for w in windows:
        # ponytail: median of programmed rates that start inside the window; a window with no rate
        # change of its own reports "current setting unknown". Upgrade: carry the rate in force.
        rates = [r.programmed for r in data.basal if w.contains(r.ts)]
        if rates:
            cur[(w.name, "basal")] = round(median(rates), 2)
    return cur


def decide(findings: list[Finding], window_stats: dict[str, dict], current: dict, measuring: set[str],
           week_id: str) -> tuple[list[Suggestion], list[Watching]]:
    order = sorted((f for f in findings if f.rule in SETTINGS),
                   key=lambda f: (f.direction != "weaker", SETTINGS.index(f.rule)))
    out, watching, taken = [], [], set()
    for f in order:
        st = window_stats[f.window]
        cur = current.get((f.window, f.rule))
        if f.window in measuring:
            reason = "measuring an applied change"
        elif st["coverage"] < MIN_COVERAGE:
            reason = "insufficient CGM data"
        elif f.events < MIN_EVENTS:
            reason = f"only {f.events} qualifying events"
        elif f.direction == "stronger" and (st["tbr"] > LOW_TBR or st["min"] < SEVERE_MIN):
            reason = "lows in this window"
        elif f.window in taken:
            reason = "one change per window per week"
        elif cur is None:
            reason = "current setting unknown"
        else:
            reason = None
        if reason:
            watching.append(Watching(f.window, f.rule, reason))
            continue
        taken.add(f.window)
        out.append(Suggestion(f"{week_id}-{f.window}-{f.rule}", f.window, f.rule, f.direction, cur,
                              step(f.rule, f.direction, cur), f.evidence))
    return out, watching
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest tests/test_suggest.py -q`
Expected: `16 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/glycolens/suggest.py tests/test_suggest.py
git commit -m "feat: guardrailed suggestions (lows win, 10% steps, one change at a time)"
```

---

### Task 10: Suggestion store and outcome tracking

**Files:**
- Modify: `src/glycolens/store.py` (append schema + functions)
- Create: `src/glycolens/outcomes.py`
- Test: `tests/test_outcomes.py`

**Interfaces:**
- Consumes: `Suggestion`, `Series`, `window_summary`, `store.load`
- Produces:
  - `store.add_suggestion(conn, s: Suggestion, created: datetime) -> None` (insert or ignore)
  - `store.get_status(conn, sid) -> str | None`
  - `store.set_status(conn, sid, status: str, at: datetime) -> str` (returns previous status; `KeyError` if unknown; `applied` sets `applied_at`, others clear it; any change resets the outcome)
  - `store.measuring_windows(conn, now) -> set[str]`
  - `store.changes(conn) -> list[dict]` (applied suggestions: `id, window, setting, direction, current, proposed, applied_at, outcome, outcome_final, before, after`)
  - `store.set_outcome(conn, sid, outcome, final: bool, before: dict, after: dict) -> None`
  - `outcomes.judge(before: dict, after: dict) -> str` (`helped | no_change | worse`)
  - `outcomes.evaluate(conn, windows, now) -> None`

- [ ] **Step 1: Write the failing tests**

`tests/test_outcomes.py`:

```python
from datetime import timedelta

import pytest

import synth
from glycolens import store
from glycolens.model import Data
from glycolens.outcomes import evaluate, judge
from glycolens.suggest import Suggestion
from glycolens.windows import DEFAULT_WINDOWS

CUT = synth.START + timedelta(days=7)
NOW = synth.START + timedelta(days=14)
# The lunch_lows fixture's lows land 14:40-15:20, inside the afternoon window.
S = Suggestion("w-afternoon-carb_ratio", "afternoon", "carb_ratio", "stronger", 10.0, 9.0, ("e",))


def test_judge():
    assert judge({"tir": 70, "tbr": 1}, {"tir": 80, "tbr": 1}) == "helped"
    assert judge({"tir": 70, "tbr": 1}, {"tir": 72, "tbr": 1}) == "no_change"
    assert judge({"tir": 70, "tbr": 1}, {"tir": 75, "tbr": 3}) == "worse"
    assert judge({"tir": 70, "tbr": 1}, {"tir": 64, "tbr": 1}) == "worse"


def test_status_lifecycle(tmp_path):
    conn = store.open_store(tmp_path / "g.db")
    store.add_suggestion(conn, S, synth.START)
    store.add_suggestion(conn, S, synth.START)  # rerun: no duplicate, no reset
    assert store.set_status(conn, S.id, "applied", CUT) == "proposed"
    assert store.get_status(conn, S.id) == "applied"
    assert store.measuring_windows(conn, CUT + timedelta(days=3)) == {"afternoon"}
    assert store.measuring_windows(conn, CUT + timedelta(days=8)) == set()
    assert store.set_status(conn, S.id, "proposed", CUT) == "applied"
    assert store.changes(conn) == []
    with pytest.raises(KeyError):
        store.set_status(conn, "nope", "applied", CUT)


def test_a_change_followed_by_lows_is_judged_worse(tmp_path):
    conn = store.open_store(tmp_path / "g.db")
    clean, lows = synth.make(), synth.make("lunch_lows")
    store.save(conn, Data(glucose=[g for g in clean.glucose if g.ts < CUT] + [g for g in lows.glucose if g.ts >= CUT]))
    store.add_suggestion(conn, S, synth.START)
    store.set_status(conn, S.id, "applied", CUT)
    evaluate(conn, DEFAULT_WINDOWS, NOW)
    (c,) = store.changes(conn)
    assert c["outcome"] == "worse" and c["outcome_final"] is False and c["after"]["tbr"] > c["before"]["tbr"]


def test_nothing_measured_before_seven_days(tmp_path):
    conn = store.open_store(tmp_path / "g.db")
    store.save(conn, synth.make())
    store.add_suggestion(conn, S, synth.START)
    store.set_status(conn, S.id, "applied", NOW - timedelta(days=3))
    evaluate(conn, DEFAULT_WINDOWS, NOW)
    assert store.changes(conn)[0]["outcome"] == "pending"
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_outcomes.py -q`
Expected: FAIL with `AttributeError: module 'glycolens.store' has no attribute 'add_suggestion'`.

- [ ] **Step 3: Implement**

Append to `SCHEMA` in `src/glycolens/store.py` (inside the same triple-quoted string):

```sql
create table if not exists suggestion(
  id text primary key, created text not null, window text not null, setting text not null,
  direction text not null, current real not null, proposed real not null, evidence text not null,
  status text not null default 'proposed', applied_at text,
  outcome text not null default 'pending', outcome_final integer not null default 0,
  before_json text, after_json text);
```

Append to `src/glycolens/store.py` (add `import json` at the top):

```python
def add_suggestion(conn: sqlite3.Connection, s, created: datetime) -> None:
    with conn:
        conn.execute("insert or ignore into suggestion (id, created, window, setting, direction, current, proposed,"
                     " evidence) values (?, ?, ?, ?, ?, ?, ?, ?)",
                     (s.id, iso(created), s.window, s.setting, s.direction, s.current, s.proposed,
                      json.dumps(list(s.evidence))))


def get_status(conn: sqlite3.Connection, sid: str) -> str | None:
    row = conn.execute("select status from suggestion where id = ?", (sid,)).fetchone()
    return None if row is None else row["status"]


def set_status(conn: sqlite3.Connection, sid: str, status: str, at: datetime) -> str:
    previous = get_status(conn, sid)
    if previous is None:
        raise KeyError(sid)
    if previous != status:
        with conn:
            conn.execute("update suggestion set status = ?, applied_at = ?, outcome = 'pending', outcome_final = 0,"
                         " before_json = null, after_json = null where id = ?",
                         (status, iso(at) if status == "applied" else None, sid))
    return previous


def measuring_windows(conn: sqlite3.Connection, now: datetime) -> set[str]:
    rows = conn.execute("select window from suggestion where status = 'applied' and applied_at > ?",
                        (iso(now - timedelta(days=7)),)).fetchall()
    return {r["window"] for r in rows}


def changes(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("select * from suggestion where status = 'applied' order by applied_at").fetchall()
    return [{"id": r["id"], "window": r["window"], "setting": r["setting"], "direction": r["direction"],
             "current": r["current"], "proposed": r["proposed"], "applied_at": r["applied_at"],
             "outcome": r["outcome"], "outcome_final": bool(r["outcome_final"]),
             "before": json.loads(r["before_json"]) if r["before_json"] else None,
             "after": json.loads(r["after_json"]) if r["after_json"] else None} for r in rows]


def set_outcome(conn: sqlite3.Connection, sid: str, outcome: str, final: bool, before: dict, after: dict) -> None:
    with conn:
        conn.execute("update suggestion set outcome = ?, outcome_final = ?, before_json = ?, after_json = ? where id = ?",
                     (outcome, int(final), json.dumps(before), json.dumps(after), sid))
```

`src/glycolens/outcomes.py`:

```python
import sqlite3
from datetime import datetime, timedelta

from glycolens import store
from glycolens.series import Series
from glycolens.stats import window_summary

MIN_AFTER = timedelta(days=7)
FULL = timedelta(days=14)
TIR_DELTA = 5.0  # percentage points
TBR_DELTA = 1.0


def judge(before: dict, after: dict) -> str:
    if after["tbr"] - before["tbr"] > TBR_DELTA or before["tir"] - after["tir"] >= TIR_DELTA:
        return "worse"
    if after["tir"] - before["tir"] >= TIR_DELTA:
        return "helped"
    return "no_change"


def evaluate(conn: sqlite3.Connection, windows, now: datetime) -> None:
    for c in store.changes(conn):
        if c["outcome_final"]:
            continue
        at = datetime.fromisoformat(c["applied_at"])
        w = next((w for w in windows if w.name == c["window"]), None)
        if w is None or now - at < MIN_AFTER:
            continue
        stop = min(now, at + FULL)
        series = Series(store.load(conn, at - FULL, stop).glucose)
        before, after = window_summary(series, w, at - FULL, at), window_summary(series, w, at, stop)
        if before["mean"] is None or after["mean"] is None:
            continue
        store.set_outcome(conn, c["id"], judge(before, after), now - at >= FULL, before, after)
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/glycolens/store.py src/glycolens/outcomes.py tests/test_outcomes.py
git commit -m "feat: suggestion lifecycle and before/after outcome tracking"
```

---

### Task 11: Tandem Source adapter

**Files:**
- Create: `src/glycolens/tandem.py`
- Test: `tests/test_tandem.py`, `tests/private/test_tandem_real.py` (git-ignored, owner only)

**Interfaces:**
- Consumes: `model.*`, `SPIKE.md` answers
- Produces: `tandem.to_data(events: Iterable) -> Data` (pure), `tandem.fetch(cfg) -> Data` (uses `cfg.region`, `cfg.analysis_days`), `tandem.login() -> None` (stores creds in `keyring` service `"glycolens"`, user `"tandem"`)

Before Step 1, set these from `SPIKE.md` at the top of `tandem.py`: the `_ts` body, `CARB_RATIO_SCALE`, `ISF_IS_MGDL`, `AUTO_BOLUS_TYPE_BITS`, `CANNULA_OK`. The code below uses the expected values; the private real-data test catches a wrong one.

- [ ] **Step 1: Write the failing tests**

`tests/test_tandem.py`:

```python
from datetime import datetime

import pytest

from glycolens import tandem
from glycolens.model import Basal, Bolus, Event

T = datetime(2026, 1, 5, 7, 0)


class _Ts:
    def __init__(self, dt):
        self.naive = dt


def ev(name, **fields):
    return type(name, (), {"eventTimestamp": _Ts(fields.pop("ts", T)), **fields})()


def test_maps_g7_readings_and_skips_unusable_ones():
    d = tandem.to_data([ev("LidCgmDataG7", currentGlucoseDisplayValue=108, glucoseValueStatusRaw=0),
                        ev("LidCgmDataG7", currentGlucoseDisplayValue=40, glucoseValueStatusRaw=6)])
    assert [(g.ts, g.mmol) for g in d.glucose] == [(T, 5.99)]


def test_joins_bolus_request_and_completion():
    d = tandem.to_data([
        ev("LidBolusRequestedMsg1", bolusId=7, carbAmount=45, bolusTypeRaw=1, carbRatioRaw=10000),
        ev("LidBolusRequestedMsg2", bolusId=7, isf=36),
        ev("LidBolusCompleted", bolusId=7, insulinDelivered=4.5),
        ev("LidBolusRequestedMsg1", bolusId=8, carbAmount=0, bolusTypeRaw=2, carbRatioRaw=10000),
        ev("LidBolusRequestedMsg2", bolusId=8, isf=36),
        ev("LidBolusCompleted", bolusId=8, insulinDelivered=1.0),
        ev("LidBolusCompleted", bolusId=9, insulinDelivered=0.6),
    ])
    assert d.boluses == [Bolus(T, 4.5, 45.0, "meal", 10.0, 2.0), Bolus(T, 1.0, 0.0, "correction", 10.0, 2.0),
                         Bolus(T, 0.6, 0.0, "auto", 0.0, 0.0)]


def test_maps_basal_and_events():
    d = tandem.to_data([
        ev("LidBasalDelivery", profileBasalRate=800, commandedRate=1120),
        ev("LidCannulaFilled", completionStatusRaw=0),
        ev("LidAaUserModeChange", currentUserModeRaw=2, previousUserModeRaw=0),
        ev("LidAaUserModeChange", currentUserModeRaw=0, previousUserModeRaw=2),
    ])
    assert d.basal == [Basal(T, 0.8, 1.12)]
    assert d.events == [Event(T, "site_change"), Event(T, "exercise_start"), Event(T, "exercise_end")]


def test_fetch_without_login_says_what_to_do(monkeypatch):
    monkeypatch.setattr(tandem.keyring, "get_password", lambda *a: None)
    with pytest.raises(RuntimeError, match="glycolens login"):
        tandem.fetch(type("Cfg", (), {"region": "EU", "analysis_days": 14})())
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_tandem.py -q`
Expected: FAIL with `ModuleNotFoundError: glycolens.tandem`.

- [ ] **Step 3: Implement**

`src/glycolens/tandem.py`:

```python
"""Tandem Source adapter on top of tconnectsync (unofficial API).

Event field names come from tconnectsync.eventparser.events; the constants below were confirmed
against a real account in the Task 1 spike (see SPIKE.md).
"""
import getpass
import json
from datetime import date, timedelta
from typing import Iterable

import keyring

from glycolens.model import MG_PER_MMOL, Basal, Bolus, Data, Event, Glucose

CARB_RATIO_SCALE = 1000  # carbRatioRaw 10000 → 10 g/U
ISF_IS_MGDL = True  # LidBolusRequestedMsg2.isf is mg/dL per U
AUTO_BOLUS_TYPE_BITS = 0  # bolusTypeRaw bits marking a Control-IQ auto-bolus; 0 = "no request message" only
CANNULA_OK = 0  # LidCannulaFilled.completionStatusRaw on success
GLUCOSE_OK = 0  # glucoseValueStatusRaw "precise value"
EXERCISE, NORMAL = 2, 0


def _ts(e):
    return e.eventTimestamp.naive


def _mode_events(e) -> list[Event]:
    cur, prev = e.currentUserModeRaw, e.previousUserModeRaw
    if cur == EXERCISE and prev != EXERCISE:
        return [Event(_ts(e), "exercise_start")]
    if prev == EXERCISE and cur != EXERCISE:
        return [Event(_ts(e), "exercise_end")]
    return []


def to_data(events: Iterable) -> Data:
    out, requests, completed = Data(), {}, []
    for e in events:
        name = type(e).__name__
        if name in ("LidCgmDataG7", "LidCgmDataGxb"):
            if e.glucoseValueStatusRaw == GLUCOSE_OK:
                out.glucose.append(Glucose(_ts(e), round(e.currentGlucoseDisplayValue / MG_PER_MMOL, 2)))
        elif name == "LidBolusRequestedMsg1":
            requests.setdefault(e.bolusId, {}).update(
                carbs=float(e.carbAmount), type=e.bolusTypeRaw, cr=e.carbRatioRaw / CARB_RATIO_SCALE)
        elif name == "LidBolusRequestedMsg2":
            requests.setdefault(e.bolusId, {})["isf"] = e.isf / MG_PER_MMOL if ISF_IS_MGDL else float(e.isf)
        elif name == "LidBolusCompleted":
            completed.append((_ts(e), e.bolusId, e.insulinDelivered))
        elif name == "LidBasalDelivery":
            out.basal.append(Basal(_ts(e), e.profileBasalRate / 1000, e.commandedRate / 1000))
        elif name == "LidCannulaFilled" and e.completionStatusRaw == CANNULA_OK:
            out.events.append(Event(_ts(e), "site_change"))
        elif name == "LidAaUserModeChange":
            out.events += _mode_events(e)
    for ts, bolus_id, units in completed:
        if units <= 0:
            continue
        r = requests.get(bolus_id)
        if r is None or "type" not in r or (AUTO_BOLUS_TYPE_BITS and r["type"] & AUTO_BOLUS_TYPE_BITS):
            out.boluses.append(Bolus(ts, round(units, 2), 0.0, "auto", 0.0, 0.0))
            continue
        kind = "meal" if r["carbs"] > 0 else "correction"
        out.boluses.append(Bolus(ts, round(units, 2), r["carbs"], kind, round(r["cr"], 1), round(r.get("isf", 0.0), 1)))
    return out


def login() -> None:
    email = input("Tandem Source email: ")
    password = getpass.getpass("Tandem Source password: ")
    keyring.set_password("glycolens", "tandem", json.dumps({"email": email, "password": password}))
    print("saved to Windows Credential Manager")


def fetch(cfg) -> Data:
    raw = keyring.get_password("glycolens", "tandem")
    if raw is None:
        raise RuntimeError("no Tandem Source login saved: run `glycolens login` first")
    creds = json.loads(raw)
    from tconnectsync.api.tandemsource import TandemSourceApi  # slow import; only when fetching

    api = TandemSourceApi(creds["email"], creds["password"], cfg.region)
    pump = api.get_pumper()["pumps"][0]
    end = date.today()
    start = end - timedelta(days=cfg.analysis_days)
    return to_data(api.pump_events(pump["assignmentId"], min_date=start.isoformat(), max_date=end.isoformat(),
                                   fetch_all_event_types=True))
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest tests/test_tandem.py -q`
Expected: `4 passed`.

- [ ] **Step 5: Owner real-data check (not committed)**

Create `tests/private/test_tandem_real.py`:

```python
"""Owner-only: checks the adapter against the real account. Never committed (tests/private/)."""
from glycolens import tandem
from glycolens.config import Config


def test_real_fetch_has_everything():
    d = tandem.fetch(Config())
    kinds = {b.kind for b in d.boluses}
    assert d.glucose and d.basal and {"meal", "auto"} <= kinds
    first = min(d.glucose, key=lambda g: g.ts)
    print("first reading", first, "— compare with the t:slim app history")
```

(`Config` arrives in Task 15; run this check after Task 15: `python -m glycolens.cli login`, then `python -m pytest tests/private -q -s`.) Expected: pass, and the printed time matches the pump's clock. If `auto` is missing, set `AUTO_BOLUS_TYPE_BITS` from `SPIKE.md` and rerun.

- [ ] **Step 6: Commit**

```bash
git add src/glycolens/tandem.py tests/test_tandem.py
git commit -m "feat: Tandem Source adapter via tconnectsync with keyring credentials"
```

---

### Task 12: Glooko drop-folder adapter

**Files:**
- Create: `src/glycolens/glooko.py`
- Test: `tests/test_glooko.py`

**Interfaces:**
- Produces: `glooko.parse_cgm_csv(text: str) -> list[Glucose]`, `glooko.read_zip(path: Path) -> Data`, `glooko.import_drop(folder: Path) -> list[tuple[Path, Data]]` (bad files renamed `*.failed`, good ones moved to `folder/imported/` by `glooko.mark_imported(path)`)

- [ ] **Step 1: Write the failing tests**

`tests/test_glooko.py`:

```python
import zipfile
from datetime import datetime

from glycolens import glooko

CSV_MMOL = "Name:Test, Date Range:01/01/2026 - 14/01/2026\nTimestamp,CGM Glucose Value (mmol/l),Serial Number\n05/01/2026 07:00,6.5,X\n05/01/2026 07:05,6.8,X\n"
CSV_MG = "Timestamp,CGM Glucose Value (mg/dl),Serial Number\n2026-01-05 07:00,117,X\n"


def test_parses_uk_mmol_export():
    got = glooko.parse_cgm_csv(CSV_MMOL)
    assert [(g.ts, g.mmol) for g in got] == [(datetime(2026, 1, 5, 7, 0), 6.5), (datetime(2026, 1, 5, 7, 5), 6.8)]


def test_converts_mgdl():
    assert glooko.parse_cgm_csv(CSV_MG)[0].mmol == 6.49


def test_drop_folder_imports_and_moves(tmp_path):
    with zipfile.ZipFile(tmp_path / "export.zip", "w") as z:
        z.writestr("cgm_data_1.csv", CSV_MMOL)
    (tmp_path / "broken.zip").write_text("not a zip")
    got = glooko.import_drop(tmp_path)
    assert len(got) == 1 and len(got[0][1].glucose) == 2
    glooko.mark_imported(got[0][0])
    assert (tmp_path / "imported" / "export.zip").exists() and (tmp_path / "broken.zip.failed").exists()
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_glooko.py -q`
Expected: FAIL with `ModuleNotFoundError: glycolens.glooko`.

- [ ] **Step 3: Implement**

`src/glycolens/glooko.py`:

```python
"""Glooko 'Export to CSV' zip, dropped into ~/.glycolens/drop/ by hand. CGM only."""
import csv
import sys
import zipfile
from datetime import datetime
from pathlib import Path

from glycolens.model import MG_PER_MMOL, Data, Glucose

FORMATS = ("%d/%m/%Y %H:%M", "%Y-%m-%d %H:%M", "%d/%m/%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S")


def _parse_ts(text: str) -> datetime:
    for fmt in FORMATS:
        try:
            return datetime.strptime(text.strip(), fmt)
        except ValueError:
            pass
    raise ValueError(f"unrecognised Glooko timestamp: {text!r}")


def parse_cgm_csv(text: str) -> list[Glucose]:
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("Timestamp"))
    reader = csv.DictReader(lines[start:])
    column = next(c for c in reader.fieldnames if "Glucose" in c)
    mmol = "mmol" in column.lower()
    return [Glucose(_parse_ts(row["Timestamp"]),
                    round(float(row[column]) if mmol else float(row[column]) / MG_PER_MMOL, 2))
            for row in reader if row[column]]


def read_zip(path: Path) -> Data:
    out = Data()
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if "cgm" in name.lower() and name.endswith(".csv"):
                out.glucose += parse_cgm_csv(z.read(name).decode("utf-8-sig"))
    return out


def import_drop(folder: Path) -> list[tuple[Path, Data]]:
    out = []
    for path in sorted(folder.glob("*.zip")):
        try:
            out.append((path, read_zip(path)))
        except (zipfile.BadZipFile, ValueError, StopIteration) as e:
            print(f"glycolens: could not read {path.name}: {e}", file=sys.stderr)
            path.rename(path.with_name(path.name + ".failed"))
    return out


def mark_imported(path: Path) -> None:
    done = path.parent / "imported"
    done.mkdir(exist_ok=True)
    path.rename(done / path.name)
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest tests/test_glooko.py -q`
Expected: `3 passed`. Once the owner has a real Glooko export, compare its CGM file name and header with `CSV_MMOL`; adjust `FORMATS` or the header match if they differ, with a test line copied from the real header (values changed).

- [ ] **Step 5: Commit**

```bash
git add src/glycolens/glooko.py tests/test_glooko.py
git commit -m "feat: Glooko CSV drop-folder adapter"
```

---

### Task 13: Report — JSON contract, text, Markdown and Vault note

**Files:**
- Create: `src/glycolens/report.py`
- Test: `tests/test_report.py`

**Interfaces:**
- Consumes: `Finding`, `Suggestion`, `Watching`, `Window`, `store.iso`
- Produces:
  - `report.SCHEMA_VERSION = 1`
  - `report.build(*, now, start, end, through, stale_since, stats, window_stats, agp, findings, suggestions, statuses, watching, changes, windows) -> dict` (keys: `schema_version, generated_at, period{start,end,days}, data_through, stale_since, summary, summary_source, stats, windows[], agp[], findings[], suggestions[], watching[], changes[]`)
  - `report.template_summary(r: dict) -> str`
  - `report.write_json(r: dict, path: Path) -> None` (atomic)
  - `report.update_status(path: Path, sid: str, status: str) -> None`
  - `report.to_markdown(r: dict) -> str`, `report.write_vault_note(r: dict, vault_root: Path) -> Path`

This dict is the contract Plan 2 mirrors as `HealthReportSchema` in Noctis.

- [ ] **Step 1: Write the failing tests**

`tests/test_report.py`:

```python
import json
from datetime import timedelta

import pytest

import synth
from glycolens import report
from glycolens.analyse import analyse
from glycolens.series import Series
from glycolens.stats import agp, summary, window_summary
from glycolens.suggest import current_settings, decide
from glycolens.windows import DEFAULT_WINDOWS

END = synth.START + timedelta(days=synth.DAYS)


def make_report(fault="weak_breakfast", stale=None):
    d = synth.make(fault)
    s = Series(d.glucose)
    ws = {w.name: window_summary(s, w, synth.START, END) for w in DEFAULT_WINDOWS}
    findings = analyse(d, DEFAULT_WINDOWS)
    sugg, watching = decide(findings, ws, current_settings(d, DEFAULT_WINDOWS), set(), "2026-W03")
    return report.build(now=END, start=synth.START, end=END, through=END, stale_since=stale,
                        stats=summary([g.mmol for g in d.glucose], synth.DAYS * 1440), window_stats=ws, agp=agp(s),
                        findings=findings, suggestions=sugg, statuses={}, watching=watching, changes=[],
                        windows=DEFAULT_WINDOWS)


def test_report_shape_and_text():
    r = make_report()
    assert r["schema_version"] == 1 and r["period"]["days"] == 14 and r["stale_since"] is None
    (s,) = r["suggestions"]
    assert s["status"] == "proposed" and "10 to 9" in s["text"]
    assert "14 of 14 meals ended high" in r["findings"][0]["text"]
    assert len(r["windows"]) == 6 and len(r["agp"]) == 24
    json.dumps(r)  # serialisable


def test_write_json_is_atomic(tmp_path, monkeypatch):
    path = tmp_path / "report.json"
    report.write_json({"schema_version": 1, "old": True}, path)

    def boom(*a):
        raise OSError("disk full")

    monkeypatch.setattr(report.os, "replace", boom)
    with pytest.raises(OSError):
        report.write_json(make_report(), path)
    assert json.loads(path.read_text()) == {"schema_version": 1, "old": True}


def test_update_status_rewrites_one_suggestion(tmp_path):
    path = tmp_path / "report.json"
    r = make_report()
    report.write_json(r, path)
    report.update_status(path, r["suggestions"][0]["id"], "applied")
    assert json.loads(path.read_text())["suggestions"][0]["status"] == "applied"


def test_markdown_is_summary_only(tmp_path):
    r = make_report(stale=END - timedelta(days=3))
    r["summary"] = report.template_summary(r)
    md = report.to_markdown(r)
    assert md.startswith("---\n") and "source: noctis-health" in md and "Data stale since" in md
    assert len(md) < 6000
    note = report.write_vault_note(r, tmp_path)
    assert note.parent == tmp_path / "inbox" and note.read_text(encoding="utf-8") == md
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_report.py -q`
Expected: FAIL with `ModuleNotFoundError: glycolens.report`.

- [ ] **Step 3: Implement**

`src/glycolens/report.py`:

```python
import json
import os
from datetime import datetime, timedelta
from pathlib import Path

from glycolens.findings import Finding
from glycolens.store import iso
from glycolens.suggest import STEP, Suggestion, Watching

SCHEMA_VERSION = 1
LABELS = {"carb_ratio": ("carb ratio", "g/U"), "isf": ("correction factor", "mmol/L per U"), "basal": ("basal", "U/h")}


def _hhmm(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def finding_text(f: Finding) -> str:
    w = f.window.capitalize()
    if f.rule == "carb_ratio" and f.direction == "stronger":
        return f"{w}: {f.hits} of {f.events} meals ended high (median +{f.metric:.1f} mmol/L at 4h)."
    if f.rule == "carb_ratio":
        return f"{w}: {f.hits} of {f.events} meals went low within 4h (lowest {f.metric:.1f})."
    if f.rule == "pre_bolus":
        return (f"{w}: {f.hits} of {f.events} meals spiked (median +{f.metric:.1f}) then came back down. "
                f"The ratio looks right; bolus earlier.")
    if f.rule == "isf":
        return f"{w}: corrections dropped {f.metric:.1f}x what your correction factor predicts ({f.hits} of {f.events})."
    if f.rule == "basal":
        return f"{w}: on {f.hits} of {f.events} fasting days basal ran at {f.metric:.0%} of programmed or glucose drifted."
    if f.rule == "missed_bolus":
        return f"{w}: {f.hits} rises of 3+ mmol/L in an hour with no bolus logged."
    if f.rule == "exercise_low":
        return f"Lows after {f.hits} of {f.events} exercise sessions (lowest {f.metric:.1f})."
    return f"Glucose ran {f.metric:.1f} mmol/L higher from day 3 of a site."


def suggestion_text(s: Suggestion) -> str:
    label, unit = LABELS[s.setting]
    verb = "strengthening" if s.direction == "stronger" else "weakening"
    return (f"{s.window.capitalize()}: consider {verb} your {label} from {s.current:g} to {s.proposed:g} {unit} "
            f"({STEP:.0%}).")


def build(*, now: datetime, start: datetime, end: datetime, through: datetime, stale_since: datetime | None, stats: dict,
          window_stats: dict, agp: list, findings: list[Finding], suggestions: list[Suggestion],
          statuses: dict, watching: list[Watching], changes: list[dict], windows) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": iso(now),
        "period": {"start": iso(start), "end": iso(end), "days": round((end - start) / timedelta(days=1))},
        "data_through": iso(through),
        "stale_since": iso(stale_since) if stale_since else None,
        "summary": "",
        "summary_source": "template",
        "stats": stats,
        "windows": [{"name": w.name, "start": _hhmm(w.start), "end": _hhmm(w.end), **window_stats[w.name]}
                    for w in windows],
        "agp": agp,
        "findings": [{"rule": f.rule, "window": f.window, "direction": f.direction, "events": f.events,
                      "hits": f.hits, "metric": f.metric, "text": finding_text(f), "evidence": list(f.evidence)}
                     for f in findings],
        "suggestions": [{"id": s.id, "window": s.window, "setting": s.setting, "direction": s.direction,
                         "current": s.current, "proposed": s.proposed, "step_pct": round(STEP * 100),
                         "text": suggestion_text(s), "evidence": list(s.evidence),
                         "status": statuses.get(s.id) or "proposed"} for s in suggestions],
        "watching": [{"window": w.window, "rule": w.rule, "reason": w.reason} for w in watching],
        "changes": changes,
    }


def template_summary(r: dict) -> str:
    st = r["stats"]
    return (f"Last {r['period']['days']} days: {st['tir']}% in range, {st['tbr']}% below. "
            f"{len(r['findings'])} findings, {len(r['suggestions'])} suggestions.")


def write_json(r: dict, path: Path) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(r, indent=2), encoding="utf-8")
    os.replace(tmp, path)  # readers see the old or the new file, never half of one


def update_status(path: Path, sid: str, status: str) -> None:
    if not path.exists():
        return
    r = json.loads(path.read_text(encoding="utf-8"))
    for s in r["suggestions"]:
        if s["id"] == sid:
            s["status"] = status
    write_json(r, path)


def to_markdown(r: dict) -> str:
    day = r["data_through"][:10]
    st = r["stats"]
    lines = ["---", f"title: glycolens weekly {day}", "tags: [health, glycolens]", f"created: {day}",
             "source: noctis-health", "---", ""]
    if r["stale_since"]:
        lines += [f"> Data stale since {r['stale_since'][:10]}.", ""]
    lines += [r["summary"], "",
              f"**Stats:** {st['tir']}% in range, {st['tbr']}% below, GMI {st['gmi']}%, CV {st['cv']}%", ""]
    lines += ["## Findings"] + [f"- {f['text']}" for f in r["findings"]] + [""]
    lines += ["## Suggestions"] + [f"- {s['text']} ({s['status']})" for s in r["suggestions"]] + [""]
    lines += ["## Past changes"] + [f"- {c['window']} {c['setting']} {c['current']:g} → {c['proposed']:g}: "
                                    f"{c['outcome']}{'' if c['outcome_final'] else ' (provisional)'}"
                                    for c in r["changes"]]
    return "\n".join(lines) + "\n"


def write_vault_note(r: dict, vault_root: Path) -> Path:
    path = vault_root / "inbox" / f"{r['data_through'][:10]}-glycolens-weekly.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(to_markdown(r), encoding="utf-8")
    return path
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest tests/test_report.py -q`
Expected: `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/glycolens/report.py tests/test_report.py
git commit -m "feat: report.json contract, template text and summary-only Vault note"
```

---

### Task 14: Qwen summary with a number check

**Files:**
- Create: `src/glycolens/narrate.py`
- Test: `tests/test_narrate.py`

**Interfaces:**
- Produces: `narrate.numbers_ok(summary: str, source: str) -> bool`, `narrate.summarise(r: dict, url: str, model: str, timeout: float = 120) -> str | None`, `narrate.for_config(r: dict, cfg) -> str | None`

- [ ] **Step 1: Write the failing tests**

`tests/test_narrate.py`:

```python
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from glycolens import narrate

REPORT = {"stats": {"tir": 82.5, "tbr": 1.2}, "findings": [{"text": "Breakfast: 5 of 6 meals ended high"}],
          "suggestions": [], "watching": [], "changes": []}


def test_numbers_ok():
    assert narrate.numbers_ok("TIR was 82.5% with 5 of 6 breakfasts high.", json.dumps(REPORT))
    assert not narrate.numbers_ok("TIR was 90%.", json.dumps(REPORT))


@pytest.fixture
def server():
    replies = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            body = json.dumps({"choices": [{"message": {"content": replies[0]}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_port}", replies
    httpd.shutdown()


def test_good_summary_is_kept_and_think_tags_stripped(server):
    url, replies = server
    replies.append("<think>hmm</think>82.5% in range; breakfast ran high on 5 of 6 days.")
    assert narrate.summarise(REPORT, url, "qwen") == "82.5% in range; breakfast ran high on 5 of 6 days."


def test_invented_number_is_rejected(server):
    url, replies = server
    replies.append("You were in range 95% of the time.")
    assert narrate.summarise(REPORT, url, "qwen") is None


def test_lm_studio_down_gives_none():
    assert narrate.summarise(REPORT, "http://127.0.0.1:9", "qwen", timeout=2) is None
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_narrate.py -q`
Expected: FAIL with `ModuleNotFoundError: glycolens.narrate`.

- [ ] **Step 3: Implement**

`src/glycolens/narrate.py`:

```python
"""Optional plain-English summary from the local Qwen model in LM Studio.

The model only rewords the findings; numbers_ok() rejects any number it did not get from them.
"""
import json
import re
import urllib.request

NUMBER = re.compile(r"\d+(?:\.\d+)?")
SYSTEM = ("Write a 3 to 5 sentence weekly summary of this type 1 diabetes pattern report for the person "
          "it is about. Use only facts and numbers from the JSON. Do not add advice beyond the listed "
          "suggestions. Plain text, no headings.")


def _numbers(text: str) -> set[str]:
    return {f"{float(n):g}" for n in NUMBER.findall(text)}


def numbers_ok(summary: str, source: str) -> bool:
    return _numbers(summary) <= _numbers(source)


def summarise(r: dict, url: str, model: str, timeout: float = 120) -> str | None:
    source = json.dumps({k: r[k] for k in ("stats", "findings", "suggestions", "watching", "changes")})
    body = {"model": model, "temperature": 0.2,
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": source}]}
    req = urllib.request.Request(f"{url}/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = json.load(resp)["choices"][0]["message"]["content"]
    except (OSError, ValueError, KeyError, IndexError):
        return None
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    return text if text and numbers_ok(text, source) else None


def for_config(r: dict, cfg) -> str | None:
    return summarise(r, cfg.lmstudio_url, cfg.model)
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest tests/test_narrate.py -q`
Expected: `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/glycolens/narrate.py tests/test_narrate.py
git commit -m "feat: local Qwen summary that is dropped if it invents a number"
```

---

### Task 15: Config, `run` pipeline and the CLI

**Files:**
- Create: `src/glycolens/config.py`, `src/glycolens/pipeline.py`, `src/glycolens/cli.py`
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Consumes: everything above
- Produces:
  - `config.Config(home: Path = ~/.glycolens, region="EU", analysis_days=14, windows=DEFAULT_WINDOWS, lmstudio_url="http://localhost:1234", model="qwen3.5-9b", vault: Path | None = None)`, `config.load_config(path: Path) -> Config`
  - `pipeline.run(cfg, *, fetch, narrate, now) -> int` (0 ok, 1 no data)
  - `pipeline.decide_cmd(cfg, sid, status, now) -> int` (0 ok, 2 unknown id)
  - `cli.main(argv=None) -> int` — subcommands `run`, `login`, `mark-applied <id>`, `dismiss <id>`, `reset <id>`; `--config` (default `~/.glycolens/config.toml`)

Config file example (`~/.glycolens/config.toml`, all keys optional):

```toml
region = "EU"
analysis_days = 14
model = "qwen3.5-9b"
lmstudio_url = "http://localhost:1234"
# vault = "C:/Users/mmush/OneDrive/MindVault"   # off until the owner turns it on

[[windows]]
name = "overnight"
start = "00:00"
end = "06:00"
# ...one block per pump segment, back to back to 24:00
```

- [ ] **Step 1: Write the failing tests**

`tests/test_pipeline.py`:

```python
import json
from datetime import timedelta

import synth
from glycolens import pipeline, store
from glycolens.config import Config, load_config

NOW = synth.START + timedelta(days=synth.DAYS)


def cfg(tmp_path, **kw):
    return Config(home=tmp_path, **kw)


def no_summary(r, c):
    return None


def failing_fetch(c):
    raise ConnectionError("Tandem said no")


def test_run_writes_a_report_with_a_suggestion(tmp_path):
    assert pipeline.run(cfg(tmp_path), fetch=lambda c: synth.make("weak_breakfast"), narrate=no_summary, now=NOW) == 0
    r = json.loads((tmp_path / "report.json").read_text())
    assert r["stale_since"] is None and r["summary_source"] == "template"
    assert [s["id"] for s in r["suggestions"]] == ["2026-W03-breakfast-carb_ratio"]


def test_rerun_keeps_status_and_does_not_duplicate(tmp_path):
    c = cfg(tmp_path)
    pipeline.run(c, fetch=lambda c: synth.make("weak_breakfast"), narrate=no_summary, now=NOW)
    assert pipeline.decide_cmd(c, "2026-W03-breakfast-carb_ratio", "applied", NOW) == 0
    pipeline.run(c, fetch=lambda c: synth.make("weak_breakfast"), narrate=no_summary, now=NOW)
    r = json.loads((tmp_path / "report.json").read_text())
    assert r["suggestions"] == [] and r["watching"][0]["reason"] == "measuring an applied change"
    conn = store.open_store(tmp_path / "glycolens.db")
    assert conn.execute("select count(*) from suggestion").fetchone()[0] == 1


def test_decide_updates_the_report_and_rejects_unknown_ids(tmp_path, capsys):
    c = cfg(tmp_path)
    pipeline.run(c, fetch=lambda c: synth.make("weak_breakfast"), narrate=no_summary, now=NOW)
    assert pipeline.decide_cmd(c, "2026-W03-breakfast-carb_ratio", "applied", NOW) == 0
    assert json.loads((tmp_path / "report.json").read_text())["suggestions"][0]["status"] == "applied"
    assert pipeline.decide_cmd(c, "2026-W03-breakfast-carb_ratio", "applied", NOW) == 0
    assert "already applied" in capsys.readouterr().out
    assert pipeline.decide_cmd(c, "typo", "applied", NOW) == 2


def test_first_run_with_failing_fetch_writes_nothing(tmp_path, capsys):
    assert pipeline.run(cfg(tmp_path), fetch=failing_fetch, narrate=no_summary, now=NOW) == 1
    assert not (tmp_path / "report.json").exists()
    assert "Tandem said no" in capsys.readouterr().err


def test_failing_fetch_with_stored_data_marks_report_stale(tmp_path):
    c = cfg(tmp_path)
    pipeline.run(c, fetch=lambda c: synth.make(), narrate=no_summary, now=NOW)
    pipeline.run(c, fetch=failing_fetch, narrate=no_summary, now=NOW + timedelta(days=7))
    r = json.loads((tmp_path / "report.json").read_text())
    assert r["stale_since"] == r["data_through"]


def test_qwen_summary_used_when_it_passes(tmp_path):
    pipeline.run(cfg(tmp_path), fetch=lambda c: synth.make(), narrate=lambda r, c: "All steady.", now=NOW)
    r = json.loads((tmp_path / "report.json").read_text())
    assert (r["summary"], r["summary_source"]) == ("All steady.", "qwen")


def test_vault_note_only_when_configured(tmp_path):
    vault = tmp_path / "vault"
    pipeline.run(cfg(tmp_path / "a"), fetch=lambda c: synth.make(), narrate=no_summary, now=NOW)
    assert not vault.exists()
    pipeline.run(cfg(tmp_path / "b", vault=vault), fetch=lambda c: synth.make(), narrate=no_summary, now=NOW)
    assert len(list((vault / "inbox").glob("*-glycolens-weekly.md"))) == 1


def test_config_defaults_and_windows(tmp_path):
    assert load_config(tmp_path / "missing.toml").analysis_days == 14
    p = tmp_path / "c.toml"
    p.write_text('region = "US"\n[[windows]]\nname = "all"\nstart = "00:00"\nend = "24:00"\n')
    c = load_config(p)
    assert c.region == "US" and [w.name for w in c.windows] == ["all"]
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_pipeline.py -q`
Expected: FAIL with `ModuleNotFoundError: glycolens.config`.

- [ ] **Step 3: Implement**

`src/glycolens/config.py`:

```python
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from glycolens.windows import DEFAULT_WINDOWS, Window, parse_windows


@dataclass
class Config:
    home: Path = field(default_factory=lambda: Path.home() / ".glycolens")
    region: str = "EU"
    analysis_days: int = 14
    windows: tuple[Window, ...] = DEFAULT_WINDOWS
    lmstudio_url: str = "http://localhost:1234"
    model: str = "qwen3.5-9b"
    vault: Path | None = None  # off by default: the owner turns Vault notes on


def load_config(path: Path) -> Config:
    if not path.exists():
        return Config()
    raw = tomllib.loads(path.read_text(encoding="utf-8"))
    cfg = Config()
    for key in ("region", "analysis_days", "lmstudio_url", "model"):
        if key in raw:
            setattr(cfg, key, raw[key])
    if "home" in raw:
        cfg.home = Path(raw["home"])
    if "vault" in raw:
        cfg.vault = Path(raw["vault"])
    if "windows" in raw:
        cfg.windows = parse_windows(raw["windows"])
    return cfg
```

`src/glycolens/pipeline.py`:

```python
import sys
from datetime import datetime, timedelta

from glycolens import glooko, outcomes, report, store
from glycolens.analyse import analyse
from glycolens.config import Config
from glycolens.series import Series
from glycolens.stats import agp, summary, window_summary
from glycolens.suggest import current_settings, decide

STALE_AFTER = timedelta(days=2)


def run(cfg: Config, *, fetch, narrate, now: datetime) -> int:
    conn = store.open_store(cfg.home / "glycolens.db")
    error = None
    try:
        store.save(conn, fetch(cfg))
    except Exception as e:  # unofficial API: any failure means "carry on with what is stored"
        error = f"{type(e).__name__}: {e}"
    drop = cfg.home / "drop"
    drop.mkdir(parents=True, exist_ok=True)
    for path, data in glooko.import_drop(drop):
        store.save(conn, data)
        glooko.mark_imported(path)

    through = store.latest_glucose(conn)
    if through is None:
        print(f"glycolens: no data yet ({error or 'nothing fetched'})", file=sys.stderr)
        return 1
    if error:
        print(f"glycolens: fetch failed, using stored data: {error}", file=sys.stderr)
    stale = through if error or now - through > STALE_AFTER else None

    start, end = through - timedelta(days=cfg.analysis_days), through + timedelta(minutes=1)
    data = store.load(conn, start, end)
    series = Series(data.glucose)
    window_stats = {w.name: window_summary(series, w, start, end) for w in cfg.windows}
    findings = analyse(data, cfg.windows)
    outcomes.evaluate(conn, cfg.windows, now)
    suggestions, watching = decide(findings, window_stats, current_settings(data, cfg.windows),
                                   store.measuring_windows(conn, now), f"{through:%G-W%V}")
    for s in suggestions:
        store.add_suggestion(conn, s, now)

    r = report.build(now=now, start=start, end=end, through=through, stale_since=stale,
                     stats=summary(series.v, (end - start) / timedelta(minutes=1)), window_stats=window_stats,
                     agp=agp(series), findings=findings, suggestions=suggestions,
                     statuses={s.id: store.get_status(conn, s.id) for s in suggestions}, watching=watching,
                     changes=store.changes(conn), windows=cfg.windows)
    text = narrate(r, cfg)
    r["summary"], r["summary_source"] = (text, "qwen") if text else (report.template_summary(r), "template")
    report.write_json(r, cfg.home / "report.json")
    if cfg.vault:
        report.write_vault_note(r, cfg.vault)
    return 0


def decide_cmd(cfg: Config, sid: str, status: str, now: datetime) -> int:
    conn = store.open_store(cfg.home / "glycolens.db")
    try:
        previous = store.set_status(conn, sid, status, now)
    except KeyError:
        print(f"glycolens: no suggestion with id {sid!r}")
        return 2
    print(f"already {status}" if previous == status else f"{sid}: {previous} → {status}")
    report.update_status(cfg.home / "report.json", sid, status)
    return 0
```

`src/glycolens/cli.py`:

```python
import argparse
from datetime import datetime
from pathlib import Path

from glycolens import narrate, pipeline, tandem
from glycolens.config import load_config

STATUS = {"mark-applied": "applied", "dismiss": "dismissed", "reset": "proposed"}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="glycolens", description="Weekly t:slim X2 + G7 pattern finder.")
    p.add_argument("--config", type=Path, default=Path.home() / ".glycolens" / "config.toml")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run", help="fetch, analyse and write report.json")
    sub.add_parser("login", help="save the Tandem Source login to Windows Credential Manager")
    for name in STATUS:
        sub.add_parser(name).add_argument("id")
    a = p.parse_args(argv)
    cfg = load_config(a.config)
    if a.cmd == "run":
        return pipeline.run(cfg, fetch=tandem.fetch, narrate=narrate.for_config, now=datetime.now())
    if a.cmd == "login":
        tandem.login()
        return 0
    return pipeline.decide_cmd(cfg, a.id, STATUS[a.cmd], datetime.now())


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/glycolens/config.py src/glycolens/pipeline.py src/glycolens/cli.py tests/test_pipeline.py
git commit -m "feat: run pipeline, decision commands and config"
```

---

### Task 16: Weekly schedule, README and real-data acceptance (owner)

**Files:**
- Create: `scripts/register-weekly.ps1`
- Modify: `README.md`

- [ ] **Step 1: Write the scheduler script**

`scripts/register-weekly.ps1`:

```powershell
# Registers "glycolens weekly": Sundays 20:00, runs late if the PC was off. Owner runs this once.
$exe = (Get-Command glycolens -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $exe -Argument "run"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 8pm
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable
Register-ScheduledTask -TaskName "glycolens weekly" -Action $action -Trigger $trigger -Settings $settings
```

- [ ] **Step 2: Extend `README.md`**

Append:

```markdown
## Use

    glycolens login            # once: saves the Tandem Source login to Windows Credential Manager
    glycolens run              # fetch the last 14 days, analyse, write ~/.glycolens/report.json
    glycolens mark-applied ID  # after changing the pump setting; dismiss ID / reset ID also exist

Manual fallback: drop a Glooko "Export to CSV" zip into `~/.glycolens/drop/`.
Weekly: `scripts/register-weekly.ps1` (Sundays 20:00).

## How it decides

Deterministic rules over 14 days of data (carb ratio, correction factor, basal vs Control-IQ delivery,
pre-bolus timing, missed boluses, exercise lows, site age). Guardrails: lows win, steps of at most 10%,
one change per window at a time, at least 4 qualifying events, 70% CGM coverage. A local LLM may reword
the summary; any number it did not get from the findings discards its text.

Personal tool, not medical advice.
```

- [ ] **Step 3: Owner acceptance on real data**

```powershell
glycolens login
glycolens run
Get-Content $HOME\.glycolens\report.json | Select-Object -First 40
python -m pytest tests/private -q -s
```

Expected: `run` exits 0; `report.json` has `stale_since: null`, stats that match Tandem Source's own time-in-range within a couple of points, and findings the owner judges plausible. Note any finding that rings false in `SPIKE.md` under "Acceptance" and fix the rule (with a new synthetic fixture reproducing it) before calling v1 done.

- [ ] **Step 4: Owner registers the weekly task**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-weekly.ps1
```

Expected: `Get-ScheduledTask "glycolens weekly"` shows `Ready`.

- [ ] **Step 5: Commit, then (with the owner's OK on public vs private) create the remote and push**

```bash
git add scripts/register-weekly.ps1 README.md SPIKE.md
git commit -m "docs: usage, weekly schedule and acceptance notes"
gh repo create glycolens --private --source . --push   # owner chooses --public/--private
```

---

## Plan 2 (separate): Noctis integration

Written after this plan ships, against the then-current Noctis code, consuming the Task 13 `report.json` contract:
`HealthReportSchema` in `packages/contracts`; home-node capabilities `health.report` (`read_inspect`) and
`health.decide` (`local_reversible_edit`, runs `glycolens mark-applied|dismiss|reset <id>`), both default-off;
a Health panel in the adaptive panel system with Applied / Dismiss and a "data stale since" banner.
