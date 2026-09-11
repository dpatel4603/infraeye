# RIPE RIS data through RIPEstat

Verified against RIPE NCC documentation and a public API response on 2026-09-11.

## Recommended source

Use the public **BGPlay** endpoint for a bounded prefix and collector set. One response contains an initial route snapshot, subsequent updates, AS descriptions, prefixes, and observation peers. Its `query_starttime` and `query_endtime` define the actual replay window. This is real RIS routing observation data; the latest available response is delayed and must not be described as a real-time stream. [BGPlay documentation](https://stat.ripe.net/docs/data-api/api-endpoints/bgplay.html)

Request: `https://stat.ripe.net/data/bgplay/data.json?resource=1.1.1.0%2F24&rrcs=00`

- `initial_state`: routes at the start of the window, each with `source_id`, `target_prefix`, `path`, and `community`.
- `events`: chronologically ordered updates with `timestamp`, `seq`, `type` (`A` announcement or `W` withdrawal), and `attrs`. Attributes include `source_id`, `target_prefix`, and announcement-only `path`/`community`.
- `sources`: observer descriptions: `id`, `rrc`, `ip`, `as_number`.
- `nodes`: actual response uses `as_number` and `owner` (the docs table spells the former `as-number`). The owner is an estimated organization name, not a physical location.
- `targets`: actual response uses objects containing `prefix`.

The live response inspected returned 47 initial routes, 84 updates, 47 observation peers, and 64 AS nodes for collector `00`, covering **2026-09-09 13:59:35 through 2026-09-11 13:59:35 UTC**. This was a 48-hour default window even though the documentation states an eight-hour default. Always display the returned window rather than assuming its length. [Actual request](https://stat.ripe.net/data/bgplay/data.json?resource=1.1.1.0%2F24&rrcs=00)

## Replay semantics

Seed route state from `initial_state`; do not manufacture announcement events to represent these already-existing routes. Use **`(source_id, target_prefix)`** as the route key. An announcement replaces that observer's previous route; a withdrawal removes only that key. Apply returned updates in timestamp/sequence order through the requested playback time. Preserve upstream sequence values for events sharing a timestamp. The source identity is the collector number plus peer IP (`[rrc]-[peer IP]`), not merely the peer ASN. [BGP State](https://stat.ripe.net/docs/data-api/api-endpoints/bgp-state.html), [BGP Updates](https://stat.ripe.net/docs/data-api/api-endpoints/bgp-updates.html)

For a later incremental implementation, `bgp-state` computes a snapshot at a requested timestamp by applying updates since the preceding eight-hour RIB dump; `bgp-updates` returns changes between requested start/end times. BGPlay bundles these concepts into one consistent response and is simpler for the initial application. The docs do not explicitly establish inclusive/exclusive update boundary semantics: avoid inferring them for incremental polling without dedicated boundary checks and deduplication. [BGP State](https://stat.ripe.net/docs/data-api/api-endpoints/bgp-state.html), [BGPlay](https://stat.ripe.net/docs/data-api/api-endpoints/bgplay.html)

## Constraints and presentation

- Query `resource`, optionally `rrcs`, and either explicit `starttime`/`endtime` or latest available defaults. The docs state only data after January 2024 was indexed as of July 31, 2025. [BGPlay](https://stat.ripe.net/docs/data-api/api-endpoints/bgplay.html)
- Label the source **RIPE RIS via RIPEstat** and show observation window, retrieval time, collector scope, and refresh errors. A cached successful observation remains real data, but must retain its original timestamps. Do not silently substitute fictional routes on failure.
- AS paths are advertised routing observations. Edges are adjacent AS numbers in these paths, not verified cables or router links. A path change or an individual observer's withdrawal alone does not establish an outage.
- Inspect both HTTP status and the response's `status`/`messages`; RIPEstat distinguishes `ok`, `error`, and `maintenance`. [API reference](https://stat.ripe.net/docs/data-api/ripestat-data-api.html)
- The public API requires no API key for these reads. Usage rules allow eight concurrent requests per source IP and ask users to register if regularly exceeding 1,000 requests/day. A small cached/manual refresh flow is sufficient here. The optional `sourceapp=infraeye` identifies the client; do not bypass caching routinely. [API rules](https://stat.ripe.net/docs/data-api/ripestat-data-api.html)
