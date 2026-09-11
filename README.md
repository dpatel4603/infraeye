# InfraEye

A map-centered local application for exploring **real RIPE RIS BGP observations**, searching networks, comparing viewpoints, and replaying recorded routing changes. React + TypeScript + Vite, FastAPI + Python, SQLite, and React Flow. No authentication, paid services, or AI integration.

## Data source

The application retrieves the free [RIPEstat BGPlay API](https://stat.ripe.net/docs/data-api/api-endpoints/bgplay.html), backed by RIPE NCC's Routing Information Service (RIS). It requests collector **RRC00 (Amsterdam)** for the public routed prefix you choose. Search IP addresses, prefixes, ASNs, company names or domains. Quick destinations include **Cloudflare DNS (1.1.1.0/24)**, **Google DNS (8.8.8.0/24)** and **Quad9 DNS (9.9.9.0/24)**. Capture requests accept IPv4 /16 or longer and IPv6 /32 or longer to keep this local application bounded.

The response contains an initial route snapshot, subsequent announcements and withdrawals, observer identities, AS owner labels, and its actual coverage window. The app displays that window, retrieval time, collector scope, source messages, and a link to the original API request. AS owners are RIPEstat's labels, not independently verified ownership claims.

**Latest available is delayed source data, not a real-time feed.** No RIS Live WebSocket is connected. Default API coverage can change; the app uses the returned bounds instead of assuming a fixed window. At initial verification the API returned 48 hours of observations, ending about two hours before retrieval.

There is no generated application data or bundled fallback dataset. The old synthetic source, fixture, and database have been removed. A failed initial retrieval shows an explicit error. If a real capture was previously saved, a failed refresh retains that capture and shows its original timestamps and the refresh failure.

SQLite caches one capture per destination in `backend/data/ripe.sqlite3`. Startup does not delete it. The backend rechecks RIPE after 15 minutes when requested, backs off failed requests for at least a minute, and prevents concurrent fetches for the same resource. Latest available polls metadata every minute; Replay stays on a recorded capture until reloaded. The source endpoint may itself cache responses.

## Local setup

Requires Node.js 20.19+ (or 22.12+), Python 3.11+, and Internet access from the backend to `https://stat.ripe.net`. No API key or environment file is needed.

```sh
cd /Users/devpatel/Dev/infraeye
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
cd frontend
npm ci
```

Terminal 1 — backend:

```sh
cd /Users/devpatel/Dev/infraeye/backend
.venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Terminal 2 — frontend:

```sh
cd /Users/devpatel/Dev/infraeye/frontend
npm run dev
```

Open http://127.0.0.1:5173. API documentation: http://127.0.0.1:8000/docs. Stop each server with Ctrl+C. Vite proxies `/api` to port 8000, so both processes must run. If either port is occupied, stop the conflicting process or change both the relevant startup port and Vite proxy setting. The first fetch may take up to a minute.

## Explore actual observations

1. **Search the Internet.** Enter `1.1.1.1`, `1.1.1.0/24`, `AS13335`, `Cloudflare`, `google.com` or another public destination. IPs map to routed prefixes and origin ASNs. Company names present actual RIPEstat matches rather than assuming a unique ASN. ASN results list up to 30 currently observed prefixes; choose one to open its graph.
2. **Read the local graph.** Simplified mode leads with provider names and retains ASNs beneath them. Technical mode leads with ASNs. Simplification never removes distinct AS hops: consecutive prepending is collapsed visually, while full paths are available in Technical mode. Provider names come from RIPE owner labels, and ASNs remain the node identity.
3. **Expand only when useful.** The graph starts with two active viewpoints. More viewpoints adds routes up to eight, with a 30-network limit; the source counts continue to describe all captured peer routes. On narrow screens the graph runs vertically. Zoom and pan work in both layouts.
4. **Select a provider.** The panel below shows Overview, Routes and History. Adjacent networks are derived from observed paths, not asserted transit/customer/peering contracts. The Routes tab can focus a particular collector/peer-IP viewpoint.
5. **Travel through time.** Replay starts at the source's initial snapshot. Play, Previous/Next and the scrubber operate on recorded update times. The history can filter path changes, announcements, withdrawals and peers. Initial routes are never manufactured as announcement events.
6. **Inspect a change.** Click a history entry for its exact previous and new path. Green marks new adjacencies; dashed amber marks previous adjacencies that are absent from the displayed current routes. Shared adjacencies can remain in another viewpoint. “Explain this change” produces a deterministic statement of the reporting peer and before/after record, with no LLM or claimed latency/outage cause.

The graph's Evidence control exposes source coverage, retrieval time and limitations. **Physical** explains that no verified facilities, cables or cross-connects are available. The app does not infer physical topology or offer fictional incident/simulation results. Only Explore and Replay are active top-level workflows. The earlier standalone Investigator and bottom tutorial sections remain absent.

### Search resolution and limits

`backend/app/search.py` uses public RIPEstat `network-info`, `searchcomplete`, `as-overview`, and `announced-prefixes` APIs. ASN prefix timelines are filtered at the latest available source time before the 30-result limit. Company results are limited to 12 networks. `network-info` can report multiple origin ASNs, which remain separate choices.

Domains resolve using the backend's system DNS resolver, then up to four public A/AAAA answers are mapped to routed prefixes. DNS depends on resolver location and can change; it identifies hosting networks, not necessarily a domain owner's network. The app never makes HTTP requests to the searched domain. Search results are cached for up to 15 minutes. Public-only validation excludes private/reserved addresses. Unknown, unrouted, unresolvable and unsupported inputs show explicit results/errors, never invented entities. Search and routing captures can have different source timestamps; evidence labels retain those limits.

## Fundamentals

| Concept | Meaning |
| --- | --- |
| ASN | Autonomous System Number: an identifier for a network under a common routing policy, not a single router. |
| Prefix | A destination IP address block. `1.1.1.0/24` contains addresses `1.1.1.0` through `1.1.1.255`; the first 24 bits identify the block. |
| AS path | Ordered ASNs reported with a route advertisement. The last ASN normally identifies the origin network. Repeated ASNs may be prepending. |
| Announcement | A route advertisement that replaces the previous route for that observation peer and prefix. |
| Withdrawal | Removes that observation peer's advertised route for the prefix. Other peers' routes remain independent. |
| Observation peer | A BGP session that contributes a particular routing viewpoint. RIPE's `source_id` includes collector number and peer IP, so two sessions with the same ASN are distinct. |

BGP describes routing information (the control plane). It does not directly measure packet delivery (the data plane). Graph edges show consecutive ASNs, not physical connections, commercial relationships, or measured traffic. A path change or withdrawal alone does **not** establish an outage or its cause. Ping, traceroute, or application measurements would provide separate reachability evidence.

## Architecture and files

```text
RIPE RIS → RIPEstat BGPlay HTTPS API → RipeSource → SQLite capture cache
                                                    ↓
                                     initial snapshot + ordered updates
                                                    ↓
                                          FastAPI route replay
                                                    ↓
                                      React UI + React Flow graph
```

- `backend/app/source.py`: RIPE adapter, response validation, timestamp/peer/path normalization, SQLite persistence, request locking/backoff, and the pure replay function.
- `backend/app/search.py`: entity resolution and bounded public-prefix validation.
- `backend/app/main.py`: small API. Capture identifiers prevent mixing events from a newly refreshed window with an old replay request.
- `frontend/src/types.ts`: frontend data model. `App.tsx` handles the map, selection panels, filters and timeline. `SearchBar.tsx` resolves input into selectable network/prefix objects. `Topology.tsx` builds a bounded graph with current/previous paths. `routeChanges.ts` supplies plain-language update labels.
- `backend/tests/recordings/`: an unmodified, real public API response for offline regression tests only. The app never reads these files or falls back to them.
- `docs/ripe-source.md`: verified official API references and implementation notes.

Normalized routes carry `id`, `timestamp` (Unix UTC seconds), `type`, `peer_id`, `prefix`, and `as_path`. Initial snapshot rows have type `snapshot` and negative local IDs. Actual updates have positive local IDs and preserve upstream `source_sequence` as a string, avoiding JavaScript integer precision concerns. The state endpoint attaches `previous_path` by folding the real initial snapshot and updates independently for each peer/prefix, so the UI can distinguish an AS-path change from an announcement with an unchanged path. Reconstruction seeds from the snapshot and applies updates through the requested timestamp, keyed by **(source_id, prefix)**. Paths with unsupported forms such as AS_SET are rejected visibly rather than flattened into misleading adjacency data.

API:

- `GET /api/search?q=<IP|prefix|ASN|company|domain>`: normalized network choices, origin ASNs, candidate prefixes, source references and resolution notes.
- `GET /api/metadata?resource=1.1.1.0/24`: loads/caches real observations and returns source provenance, bounds, peers and AS labels.
- `GET /api/state?resource=1.1.1.0/24&at=<unix-seconds>&dataset_id=<metadata-id>`: snapshot plus the capture's actual event history. Out-of-window requests return 422; an obsolete capture ID returns 409.
- `GET /api/events?resource=1.1.1.0/24&at=<unix-seconds>&type=withdrawal&peer_id=<source-id>`: optional inclusive cutoff, type, peer and prefix filters.

This intentionally retains one current captured window per resource, not an unbounded archive. It does not implement best-path selection, ADD-PATH, AS_SET, or a live collector connection. A future adapter can supply the same normalized metadata, initial routes, and events without changing the frontend's route shape.

## Verification

```sh
cd /Users/devpatel/Dev/infraeye/backend
.venv/bin/python -m pytest -q
cd ../frontend
npm run typecheck
npm run build
```

Tests use a recorded real RIPE response to verify initial state, actual withdrawals and independent peers, re-announcement, reverse input ordering, sequence/owner preservation, API filtering and bounds, persistent cache reopening, explicit offline errors, and stale-real-cache reporting. Malformed-path tests mutate an in-memory copy only to verify rejection.

## Next step

If real-time observations are required, add a RIPE RIS Live adapter with an explicit initial-state strategy, session identity, deduplication and reconnect-gap reporting. Keep collector visibility and feed freshness visible. The current Explore map shows **Latest available** observations rather than implying a real-time stream.

### RIPE Atlas: measured RTT, loss and traceroute

The measurement panel uses existing **public RIPE Atlas** ping and traceroute results. It never creates measurements, needs no API key, and spends no credits. BGP AS paths are never converted into latency.

`GET /api/atlas?target=8.8.8.8&at=<unix-seconds>&asn=7018&probe_id=<optional-id>` discovers up to five ongoing public ping measurements for an exact destination IP and up to 100 participating probes. A matching source ASN is preferred; if none is found, explicitly select a separate probe. This is bounded discovery, not a complete inventory, and excludes stopped historical measurements. The probe stays fixed as you replay or change BGP viewpoints. RTT history covers the preceding hour only; future samples are excluded. Up to three ongoing traceroute measurements are checked for the same probe and IP. No result means unavailable coverage, not an outage.

Median RTT uses valid packet RTT samples in each ping result. Packet loss uses reported sent/received counts; missing counts stay unknown. All time comparisons use the same probe, destination and measurement. The first-to-last RTT difference is descriptive, not an incident detector. Traceroute values are round trips to individual responders, not delays on individual links. Anycast, asymmetric routing, congestion and ICMP response priority complicate interpretation. Same ASN does not establish the same forwarding path as the RIS observer. Atlas probe ASN/country metadata are current and may differ historically.

Atlas responses are cached in SQLite for five minutes, with expired entries pruned after a day. Retrieval failures are explicit. The three destination shortcuts use their actual DNS IPs; other prefixes require an exact IP, or use the address returned by domain search. Entering an unrelated IP measures that IP separately and does not establish a relationship to the viewed prefix.

A next step is a curated set of stable Atlas probes and measurements, preserving their metadata over time, with aligned before/after windows around BGP events. Correlation should retain distinct RIS peer and Atlas probe identities and never imply causation.

### Interpreting the routing view

The default view summarizes recorded route availability, common route patterns and the latest route-state change. It deliberately does not label a destination “healthy” or equate an advertised route with successful packet delivery. Counts refer to observation peers (collector + peer IP), not unique ASNs, users or traffic volume.

Patterns group routes by destination prefix and the complete AS sequence after the observing network, collapsing only consecutive duplicate ASNs for display. Their percentages represent route records. The graph initially selects representatives of the most common patterns; individual-observer mode ranks peers by update count. A selected event or viewpoint takes priority.

“Important events” includes new routes, changed exact AS paths (including prepending), and withdrawals that remove a known route. Identical announcements and repeated withdrawals remain available under “All BGP updates.” Timeline ticks, playback and the event list use the same scope. This is state-change filtering, not anomaly detection or outage severity classification. Summaries cover only the elapsed portion of the capture at replay time.

Run interpretation tests with `npm --prefix frontend test`. Tests cover unchanged updates, withdrawals, prepending, and pattern grouping without losing intermediate networks or combining different destinations.
