"""Read existing public Atlas measurements; never create measurements or spend credits."""
import ipaddress
import json
import math
import sqlite3
import statistics
import time

import httpx

BASE = 'https://atlas.ripe.net/api/v2'


def ping_sample(record):
    replies = [r['rtt'] for r in record.get('result', [])
               if isinstance(r.get('rtt'), (int, float)) and math.isfinite(r['rtt']) and r['rtt'] >= 0]
    sent = record.get('sent')
    received = record.get('rcvd')
    loss = (100 * (sent - received) / sent if isinstance(sent, int) and sent > 0
            and isinstance(received, int) and 0 <= received <= sent else None)
    return {'timestamp': record['timestamp'], 'median_rtt': statistics.median(replies) if replies else None,
            'packet_loss': loss, 'samples': replies}


class AtlasSource:
    def __init__(self, path):
        self.path = path
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE IF NOT EXISTS atlas_cache (key TEXT PRIMARY KEY, fetched REAL, body TEXT)')

    async def api(self, client, endpoint, **params):
        url = str(httpx.URL(f'{BASE}/{endpoint}', params=params))
        with sqlite3.connect(self.path) as db:
            row = db.execute('SELECT fetched, body FROM atlas_cache WHERE key=?', (url,)).fetchone()
        if row and time.time() - row[0] < 300:
            return json.loads(row[1])
        response = await client.get(url)
        response.raise_for_status()
        body = response.json()
        with sqlite3.connect(self.path) as db:
            db.execute('DELETE FROM atlas_cache WHERE fetched < ?', (time.time() - 86400,))
            db.execute('INSERT OR REPLACE INTO atlas_cache VALUES (?, ?, ?)', (url, time.time(), json.dumps(body)))
        return body

    async def load(self, target, at, asn=None, probe_id=None):
        address = ipaddress.ip_address(target)
        if not address.is_global or address.is_multicast:
            raise ValueError('Choose a public destination IP address.')
        target = str(address)
        output = {'target': target, 'at': at, 'start': at - 3600, 'probes': [], 'probe': None,
                  'samples': [], 'traceroute': None, 'measurement_id': None,
                  'notice': 'Discovery checks up to 5 ongoing public ping measurements and 100 probes. Missing data does not imply an outage.'}
        async with httpx.AsyncClient(timeout=20) as client:
            measurements = await self.api(client, 'measurements/', target_ip=target, type='ping', status=2, page_size=5)
            candidates = {}
            for measurement in measurements['results'][:5]:
                if not measurement.get('is_public') or measurement.get('target_ip') != target:
                    continue
                records = await self.api(client, f"measurements/{measurement['id']}/latest/")
                for record in records:
                    if record.get('dst_addr') == target and record.get('prb_id'):
                        candidates.setdefault(record['prb_id'], measurement['id'])
            ids = sorted(candidates)[:100]
            if probe_id in candidates and probe_id not in ids:
                ids[-1:] = [probe_id]
            if not ids:
                return output
            probes = await self.api(client, 'probes/', id__in=','.join(map(str, ids)), page_size=100)
            output['probes'] = [{'id': p['id'], 'asn': p.get(f'asn_v{address.version}'), 'country': p.get('country_code')}
                                for p in probes['results'] if p.get('is_public')]
            output['probes'].sort(key=lambda p: (p['asn'] != asn, p['id']))
            chosen = next((p for p in output['probes'] if p['id'] == probe_id), None) if probe_id else next((p for p in output['probes'] if p['asn'] == asn), None)
            if not chosen:
                output['notice'] = 'No matching probe in this bounded search. Choose a listed probe to inspect its separate measurements; it is not the BGP observer.'
                return output
            output['probe'] = chosen
            mid = candidates[chosen['id']]
            output['measurement_id'] = mid
            records = await self.api(client, f'measurements/{mid}/results/', probe_ids=chosen['id'], start=at - 3600, stop=at)
            output['samples'] = sorted([ping_sample(r) for r in records if r.get('prb_id') == chosen['id']
                                         and r.get('dst_addr') == target and at - 3600 <= r.get('timestamp', 0) <= at], key=lambda r: r['timestamp'])
            output['notice'] = 'Same ASN does not mean the same router or forwarding path. Probe ASN/country are current metadata, not historical location evidence.'
            try:
                traces = await self.api(client, 'measurements/', target_ip=target, type='traceroute', status=2, page_size=3)
                for measurement in traces['results'][:3]:
                    if not measurement.get('is_public') or measurement.get('target_ip') != target:
                        continue
                    records = await self.api(client, f"measurements/{measurement['id']}/results/", probe_ids=chosen['id'], start=at - 3600, stop=at)
                    valid = [r for r in records if r.get('prb_id') == chosen['id'] and r.get('dst_addr') == target and at - 3600 <= r.get('timestamp', 0) <= at]
                    if valid:
                        record = max(valid, key=lambda r: r['timestamp'])
                        output['traceroute'] = {'measurement_id': measurement['id'], 'timestamp': record['timestamp'],
                                                'hops': [{'hop': h.get('hop'), 'replies': [{'ip': r.get('from'), 'rtt': r.get('rtt')} for r in h.get('result', [])]} for h in record.get('result', [])]}
                        break
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                output['trace_error'] = 'Traceroute retrieval failed; ping results remain available.'
        return output
