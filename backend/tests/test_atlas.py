import asyncio
import pytest
from app.atlas import AtlasSource, ping_sample


def test_ping_uses_real_samples_and_packet_counts():
    sample = ping_sample({'timestamp': 10, 'sent': 4, 'rcvd': 3, 'result': [{'rtt': 18.4}, {'rtt': 19.1}, {'rtt': 18.7}, {'x': '*'}]})
    assert sample['median_rtt'] == 18.7
    assert sample['packet_loss'] == 25
    assert ping_sample({'timestamp': 10, 'sent': 3, 'rcvd': 0, 'result': [{'x': '*'}]})['median_rtt'] is None
    assert ping_sample({'timestamp': 10, 'result': [{'error': 'failed'}]})['packet_loss'] is None


class RecordedSource(AtlasSource):
    async def api(self, client, endpoint, **params):
        if endpoint == 'measurements/':
            return {'results': [] if params['type'] == 'traceroute' else [{'id': 1, 'target_ip': '8.8.8.8', 'is_public': True}]}
        if endpoint.endswith('/latest/'):
            return [{'prb_id': 2, 'dst_addr': '8.8.8.8'}]
        if endpoint == 'probes/':
            return {'results': [{'id': 2, 'asn_v4': 7018, 'country_code': 'US', 'is_public': True}]}
        return [{'prb_id': probe, 'dst_addr': target, 'timestamp': timestamp, 'sent': 3, 'rcvd': 3,
                 'result': [{'rtt': 18.4}, {'rtt': 19.1}, {'rtt': 18.7}]} for probe, target, timestamp in
                [(2, '8.8.8.8', 9900), (2, '8.8.8.8', 10001), (3, '8.8.8.8', 9900), (2, '1.1.1.1', 9900), (2, '8.8.8.8', 1)]]


def test_only_same_probe_exact_target_and_past_window(tmp_path):
    source = RecordedSource(tmp_path / 'atlas.sqlite')
    result = asyncio.run(source.load('8.8.8.8', 10000, 7018))
    assert result['probe']['id'] == 2
    assert len(result['samples']) == 1
    assert result['samples'][0]['timestamp'] == 9900
    assert result['traceroute'] is None


def test_no_automatic_substitution_of_another_asn(tmp_path):
    source = RecordedSource(tmp_path / 'atlas.sqlite')
    result = asyncio.run(source.load('8.8.8.8', 10000, 123))
    assert result['probe'] is None
    assert result['samples'] == []
    assert len(result['probes']) == 1
    # Explicit choice stays pinned even when the BGP viewpoint changes.
    assert asyncio.run(source.load('8.8.8.8', 10000, 123, 2))['probe']['id'] == 2


def test_private_target_rejected(tmp_path):
    with pytest.raises(ValueError):
        asyncio.run(RecordedSource(tmp_path / 'atlas.sqlite').load('127.0.0.1', 10000))
