"""Replay checks use an unmodified public RIPE response, never app fallback data."""
import asyncio
import copy
import json
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.source import RipeSource, epoch, normalize, reconstruct

RESOURCE = "1.1.1.0/24"
RECORDING = Path(__file__).parent / "recordings/ripe-bgplay-20260911.json"


@pytest.fixture
def raw():
    return json.loads(RECORDING.read_text())


@pytest.fixture
def capture(raw):
    return normalize(raw, RESOURCE, int(time.time()))


@pytest.fixture
def source(tmp_path, capture):
    source = RipeSource(tmp_path / "ripe.sqlite3")
    source.save(RESOURCE, capture)
    return source


def test_real_initial_state_is_not_an_announcement(capture):
    assert len(capture["initial"]) == 47
    assert len(capture["events"]) == 84
    assert all(r["type"] == "snapshot" for r in capture["initial"])
    assert all(e["type"] in ("announcement", "withdrawal") for e in capture["events"])
    start = capture["metadata"]["start"]
    assert len(reconstruct(capture["events"], start, capture["initial"])) == 47
    assert reconstruct(capture["events"], start - 1, capture["initial"]) == []


def test_real_withdrawal_keeps_all_other_observers(capture):
    events, initial = capture["events"], capture["initial"]
    withdrawal = next(e for e in events if e["type"] == "withdrawal")
    assert withdrawal["peer_id"] == "00-102.208.105.2"
    before = {r["peer_id"]: r for r in reconstruct(events, withdrawal["timestamp"] - 1, initial)}
    after = {r["peer_id"]: r for r in reconstruct(events, withdrawal["timestamp"], initial)}
    assert withdrawal["peer_id"] in before
    assert withdrawal["peer_id"] not in after
    assert after == {peer: route for peer, route in before.items() if peer != withdrawal["peer_id"]}


def test_actual_reannouncement_and_rewind(capture):
    events, initial = capture["events"], capture["initial"]
    withdrawal = next(e for e in events if e["type"] == "withdrawal")
    announcement = next(e for e in events if e["type"] == "announcement" and e["peer_id"] == withdrawal["peer_id"] and e["timestamp"] > withdrawal["timestamp"])
    later = reconstruct(events, announcement["timestamp"], initial)
    assert next(r for r in later if r["peer_id"] == announcement["peer_id"])["as_path"] == announcement["as_path"]
    assert len(reconstruct(events, capture["metadata"]["start"], initial)) == 47
    assert reconstruct(list(reversed(events)), announcement["timestamp"], initial) == later


def test_normalization_preserves_upstream_sequences_and_owner_names(raw, capture):
    ordered = sorted(raw["data"]["events"], key=lambda e: (epoch(e["timestamp"]), e["seq"]))
    assert [e["source_sequence"] for e in capture["events"]] == [str(e["seq"]) for e in ordered]
    assert all(p["id"].startswith("00-") for p in capture["metadata"]["peers"])
    assert any(a["asn"] == 13335 for a in capture["metadata"]["asns"])


def test_unsupported_paths_are_not_silently_flattened(raw):
    invalid = copy.deepcopy(raw)
    invalid["data"]["initial_state"][0]["path"] = [13335, [174, 3356]]
    with pytest.raises(ValueError, match="Unsupported AS path"):
        normalize(invalid, RESOURCE, 0)


def test_api_filters_capture_version_and_bounds(source, capture):
    with TestClient(create_app(source)) as client:
        meta = client.get('/api/metadata').json()
        assert meta['data_label'] == 'RIPE RIS observations'
        assert meta['source_url'].startswith('https://stat.ripe.net/')
        at = next(e['timestamp'] for e in capture['events'] if e['type'] == 'withdrawal')
        events = client.get('/api/events', params={'at': at, 'type': 'withdrawal', 'peer_id': '00-102.208.105.2'}).json()
        assert len(events) == 1
        state = client.get('/api/state', params={'at': at, 'dataset_id': meta['dataset_id']}).json()
        assert state['routes'] == reconstruct(capture['events'], at, capture['initial'])
        assert client.get('/api/state', params={'at': at, 'dataset_id': 'obsolete'}).status_code == 409
        assert client.get('/api/state', params={'at': meta['start'] - 1}).status_code == 422
        assert client.get('/api/state').status_code == 422
        assert client.get('/api/events?type=invalid').status_code == 422
        assert client.get('/api/metadata?resource=192.0.2.0/24').status_code == 422


def fail_network(monkeypatch):
    original = httpx.AsyncClient
    def fail(request):
        raise httpx.ConnectError("Offline during test", request=request)
    monkeypatch.setattr('app.source.httpx.AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(fail)))


def test_failure_without_cache_returns_unavailable(tmp_path, monkeypatch):
    fail_network(monkeypatch)
    with TestClient(create_app(RipeSource(tmp_path / 'empty.sqlite3'))) as client:
        response = client.get('/api/metadata')
        assert response.status_code == 503
        assert 'Offline during test' in response.json()['detail']


def test_failure_retains_real_capture_and_reports_error(source, capture, monkeypatch):
    capture['metadata']['fetched_at'] = 0
    source.save(RESOURCE, capture)
    fail_network(monkeypatch)
    value = asyncio.run(source.load(RESOURCE))
    assert value['events'] == capture['events']
    assert value['metadata']['retrieval_error']
    assert value['metadata']['fetched_at'] == 0
    assert source.read(RESOURCE)['events'] == capture['events']


def test_reopening_database_preserves_capture(source, capture):
    reopened = RipeSource(source.database)
    assert reopened.read(RESOURCE) == capture
