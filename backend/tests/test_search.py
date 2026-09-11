"""Resolver tests use recorded RIPE responses and a controlled DNS boundary."""
import asyncio
import json
import socket
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.search import EntitySearch
from app.source import change_history, normalize, reconstruct

RECORDINGS = Path(__file__).parent / 'recordings/entity-search'


def recording(endpoint):
    return json.loads((RECORDINGS / f'{endpoint}.json').read_text())['data']


@pytest.fixture
def resolver(monkeypatch):
    resolver = EntitySearch()
    async def api(client, endpoint, resource):
        return recording(endpoint)
    monkeypatch.setattr(resolver, 'api', api)
    return resolver


def test_ip_resolves_actual_google_prefix_and_preserves_origin(resolver):
    value = asyncio.run(resolver.resolve('8.8.8.8'))
    result = value['results'][0]
    assert result['prefix'] == '8.8.8.0/24'
    assert result['asn'] == 15169
    assert result['origin_asns'] == [15169]
    assert result['kind'] == 'network'


def test_company_search_preserves_multiple_asn_candidates(resolver):
    result = asyncio.run(resolver.resolve('Google'))
    candidates = result['results']
    assert len(candidates) > 1
    assert any(entity['asn'] == 15169 for entity in candidates)
    assert all(entity['kind'] == 'asn' and entity['prefixes'] == [] for entity in candidates)


def test_asn_filters_historical_prefixes_before_limiting(resolver):
    result = asyncio.run(resolver.resolve('AS13335'))['results'][0]
    raw = recording('announced-prefixes')
    at = min(raw['latest_time'], raw['query_endtime'])
    current = {p['prefix'] for p in raw['prefixes'] if any(t['starttime'] <= at <= t['endtime'] for t in p['timelines'])}
    assert result['prefix_count'] > 30
    assert len(result['prefixes']) == 30
    assert set(result['prefixes']) <= current
    assert '1.1.1.0/24' in result['prefixes']


@pytest.mark.parametrize('query', ['127.0.0.1', '192.168.1.1', '192.0.2.0/24', '1.0.0.0/8', 'AS4294967296'])
def test_unroutable_or_unbounded_inputs_are_rejected(resolver, query):
    with pytest.raises(ValueError):
        asyncio.run(resolver.resolve(query))


def test_unknown_route_does_not_invent_an_entity(resolver, monkeypatch):
    async def no_route(client, endpoint, resource):
        return {'prefix': '', 'asns': []}
    monkeypatch.setattr(resolver, 'api', no_route)
    with pytest.raises(ValueError, match='no routed prefix'):
        asyncio.run(resolver.resolve('8.8.8.8'))


def test_domain_uses_dns_then_public_routing_lookup(resolver, monkeypatch):
    async def run():
        async def dns(*args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 0))]
        monkeypatch.setattr(asyncio.get_running_loop(), 'getaddrinfo', dns)
        return await resolver.resolve('google.com')
    result = asyncio.run(run())
    assert result['results'][0]['resolved_address'] == '8.8.8.8'
    assert result['results'][0]['prefix'] == '8.8.8.0/24'
    assert 'not necessarily the domain owner' in result['notice']


def test_api_search_validation_and_response(monkeypatch):
    with TestClient(create_app()) as client:
        async def resolve(query):
            return {'query': query, 'results': [], 'notice': 'No matching networks'}
        monkeypatch.setattr(client.app.state.search, 'resolve', resolve)
        assert client.get('/api/search?q=Google').json()['query'] == 'Google'
        assert client.get('/api/search?q=').status_code == 422


def test_change_history_uses_real_prior_routes_and_observer_isolation():
    raw = json.loads((Path(__file__).parent / 'recordings/ripe-bgplay-20260911.json').read_text())
    capture = normalize(raw, '1.1.1.0/24', 0)
    events = change_history(capture['events'], capture['initial'])
    withdrawal = next(event for event in events if event['type'] == 'withdrawal')
    before = reconstruct(capture['events'], withdrawal['timestamp'] - 1, capture['initial'])
    prior = next(route for route in before if route['peer_id'] == withdrawal['peer_id'])
    assert withdrawal['previous_path'] == prior['as_path']
    next_announcement = next(event for event in events if event['peer_id'] == withdrawal['peer_id'] and event['type'] == 'announcement' and event['id'] > withdrawal['id'])
    assert next_announcement['previous_path'] is None
    assert all('previous_path' not in event for event in capture['events'])
    assert change_history(list(reversed(capture['events'])), capture['initial']) == events
