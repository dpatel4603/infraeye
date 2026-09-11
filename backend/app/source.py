"""Real RIPE RIS observations, retrieved through the free RIPEstat BGPlay API."""
import asyncio
import ipaddress
import json
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

import httpx

ROOT = Path(__file__).resolve().parents[2]
API = "https://stat.ripe.net/data/bgplay/data.json"
RESOURCES = ("1.1.1.0/24", "8.8.8.0/24", "9.9.9.0/24")
REFRESH_SECONDS = 900


class RouteSource(Protocol):
    async def load(self, resource: str) -> dict: ...
    def read(self, resource: str) -> dict | None: ...


def epoch(value: str) -> int:
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=timezone.utc).timestamp())


def normalize(response: dict, resource: str, fetched_at: int) -> dict:
    """Keep RIB state separate: snapshot rows are not invented announcement events."""
    if response.get("status") != "ok":
        raise ValueError("RIPEstat did not return a successful response")
    data = response["data"]
    start, end = epoch(data["query_starttime"]), epoch(data["query_endtime"])
    if start > end or data["resource"] != resource:
        raise ValueError("RIPEstat returned an inconsistent resource or time window")
    sources = {p["id"]: p for p in data["sources"]}

    def route(attrs: dict) -> dict:
        prefix = str(ipaddress.ip_network(attrs["target_prefix"], strict=True))
        if attrs["source_id"] not in sources:
            raise ValueError("RIPEstat returned an unidentified observation peer")
        path = attrs.get("path", [])
        # Do not flatten an AS_SET or silently turn an unsupported update into a route.
        if not isinstance(path, list) or any(type(asn) is not int or not 0 < asn <= 4294967295 for asn in path):
            raise ValueError("Unsupported AS path in RIPEstat response; previous capture retained")
        return {"peer_id": attrs["source_id"], "prefix": prefix, "as_path": path}

    initial = []
    for index, attrs in enumerate(data["initial_state"]):
        r = route(attrs)
        if not r["as_path"]:
            raise ValueError("Initial route has an empty AS path")
        initial.append({**r, "id": -(index + 1), "timestamp": start, "type": "snapshot"})
    events = []
    # RIPE seq breaks ties; local integer ids keep the frontend's event model small.
    ordered = sorted(data["events"], key=lambda e: (epoch(e["timestamp"]), int(e["seq"])))
    for index, event in enumerate(ordered):
        if event["type"] not in ("A", "W"):
            raise ValueError("Unsupported RIPEstat event type")
        r = route(event["attrs"])
        timestamp = epoch(event["timestamp"])
        if not start <= timestamp <= end:
            raise ValueError("Event outside the returned coverage window")
        if event["type"] == "A" and not r["as_path"]:
            raise ValueError("Announcement has an empty AS path")
        events.append({**r, "id": index + 1, "timestamp": timestamp,
                       "type": "announcement" if event["type"] == "A" else "withdrawal",
                       "source_sequence": str(event["seq"])})
    names = {int(n["as_number"]): n.get("owner") or f"AS{n['as_number']}" for n in data["nodes"]}
    asns = sorted({asn for r in initial + events for asn in r["as_path"]})
    meta = {
        "data_label": "RIPE RIS observations", "resource": resource,
        "resources": list(RESOURCES), "start": start, "end": end,
        "fetched_at": fetched_at, "dataset_id": response["query_id"],
        "source_url": str(httpx.URL(API, params={"resource": resource, "rrcs": "00"})),
        "collector": "RRC00 · Amsterdam", "refresh_seconds": REFRESH_SECONDS,
        "event_count": len(events), "initial_route_count": len(initial),
        "messages": response.get("messages", []),
        "asns": [{"asn": asn, "name": names.get(asn, f"AS{asn}"), "role": "Observed AS"} for asn in asns],
        "prefixes": sorted({r["prefix"] for r in initial + events}),
        "peers": [{"id": p["id"], "name": f"AS{p['as_number']} · {p['ip']}",
                   "asn": int(p["as_number"]), "collector": str(p["rrc"]), "ip": p["ip"]}
                  for p in sources.values()],
    }
    return {"metadata": meta, "initial": initial, "events": events}


def reconstruct(events: list[dict], at: int, initial: list[dict] = ()) -> list[dict]:
    """Inclusive timestamp, independent (collector/peer IP, prefix) route state."""
    routes = {(r["peer_id"], r["prefix"]): r for r in initial if r["timestamp"] <= at}
    for event in sorted(events, key=lambda e: (e["timestamp"], e["id"])):
        if event["timestamp"] > at:
            break
        key = (event["peer_id"], event["prefix"])
        if event["type"] == "withdrawal":
            routes.pop(key, None)
        else:
            routes[key] = event
    return [routes[key] for key in sorted(routes)]


def change_history(events: list[dict], initial: list[dict]) -> list[dict]:
    """Attach the preceding observation to each actual update for factual diffs."""
    state = {(r["peer_id"], r["prefix"]): r["as_path"] for r in initial}
    result = []
    for event in sorted(events, key=lambda e: (e["timestamp"], e["id"])):
        key = (event["peer_id"], event["prefix"])
        result.append({**event, "previous_path": state.get(key)})
        if event["type"] == "withdrawal":
            state.pop(key, None)
        else:
            state[key] = event["as_path"]
    return result


class RipeSource:
    """One atomic, durable capture per resource. No synthetic or bundled fallback."""
    def __init__(self, database: Path):
        self.database = database
        self.errors: dict[str, str] = {}
        self.attempts: dict[str, float] = {}
        self.locks: dict[str, asyncio.Lock] = {}
        database.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(database) as db:
            db.execute("CREATE TABLE IF NOT EXISTS captures (resource TEXT PRIMARY KEY, payload TEXT NOT NULL)")

    def read(self, resource: str) -> dict | None:
        with sqlite3.connect(self.database) as db:
            row = db.execute("SELECT payload FROM captures WHERE resource = ?", (resource,)).fetchone()
        return json.loads(row[0]) if row else None

    def save(self, resource: str, capture: dict):
        with sqlite3.connect(self.database) as db:
            db.execute("INSERT INTO captures VALUES (?, ?) ON CONFLICT(resource) DO UPDATE SET payload=excluded.payload", (resource, json.dumps(capture)))

    async def load(self, resource: str) -> dict:
        async with self.locks.setdefault(resource, asyncio.Lock()):
            cached = self.read(resource)
            now = int(time.time())
            due = not cached or now - cached["metadata"]["fetched_at"] >= REFRESH_SECONDS
            # Back off failures as well as successes; a browser poll must not hammer RIPE.
            if due and now - self.attempts.get(resource, 0) >= 60:
                self.attempts[resource] = now
                try:
                    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
                        response = await client.get(API, params={"resource": resource, "rrcs": "00"}, headers={"User-Agent": "InfraEye/0.1 (local BGP learning application)"})
                        response.raise_for_status()
                        capture = normalize(response.json(), resource, now)
                    self.save(resource, capture)
                    cached = capture
                    self.errors.pop(resource, None)
                except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
                    self.errors[resource] = f"RIPEstat retrieval failed: {error}"
            if cached is None:
                raise RuntimeError(self.errors.get(resource, "Waiting for RIPEstat observations"))
            cached["metadata"]["retrieval_error"] = self.errors.get(resource)
            cached["metadata"]["cache_age_seconds"] = max(0, now - cached["metadata"]["fetched_at"])
            return cached
