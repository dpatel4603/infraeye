# Real routing entity search

Verified against RIPE NCC documentation and successful public requests on 2026-09-11. These are implementation recommendations, not claims that every feature below is already implemented.

## Sources and verified response shapes

RIPEstat is a public HTTPS JSON API. The calls below succeeded without credentials or payment. Check HTTP status and the JSON `status` (`ok`, `error`, or `maintenance`), and preserve useful `messages`. The official usage policy limits one IP to eight concurrent calls and asks regular users exceeding 1,000 requests/day to register; `sourceapp=infraeye` identifies the application. Cache responses and use a lower application concurrency limit. [API documentation](https://stat.ripe.net/docs/data-api/ripestat-data-api/)

### IP → observed prefix and origin ASN

[Network Info documentation](https://stat.ripe.net/docs/data-api/api-endpoints/network-info/), [verified request](https://stat.ripe.net/data/network-info/data.json?resource=8.8.8.8):

```json
{"asns":["15169"],"prefix":"8.8.8.0/24"}
```

This is the response's `data` object. ASNs are strings in an array: preserve multiple origins. RIPE documents RISwhois as the source, based on eight-hour dumps, so this is delayed routing visibility, not live status. A request for `192.0.2.1` returned `{"asns":[],"prefix":""}` successfully: absence of a route is a valid empty result. A request for `8.8.8.0/24` also worked, but the documented input is an IP; preserve explicitly entered prefixes rather than replacing them with a containing route derived from their first address. A request for `google.com` returned HTTP 400: hostname unsupported.

### ASN → holder

[AS Overview documentation](https://stat.ripe.net/docs/data-api/api-endpoints/as-overview/), [verified request](https://stat.ripe.net/data/as-overview/data.json?resource=AS328840):

```json
{"type":"as","resource":"328840","holder":"ST DIGITAL - ST DIGITAL","announced":true,"query_starttime":"2026-09-11T08:00:00","query_endtime":"2026-09-11T08:00:00"}
```

The full response also has an allocation `block`. Display a cleaned holder name with the ASN alongside it; retain the raw holder in details. The holder is a source label, not independently verified corporate ownership.

### ASN → observed prefixes

[Announced Prefixes documentation](https://stat.ripe.net/docs/data-api/api-endpoints/announced-prefixes/), [verified request](https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS13335):

```json
{"prefixes":[{"prefix":"172.68.159.0/24","timelines":[{"starttime":"2026-08-28T08:00:00","endtime":"2026-09-11T08:00:00"}]}],"query_starttime":"2026-08-28T08:00:00","query_endtime":"2026-09-11T08:00:00","latest_time":"2026-09-11T08:00:00","resource":"13335"}
```

This excerpt contains one of 5,377 prefixes. Default query coverage is the last two weeks; default `min_peers_seeing=10` excludes low-visibility announcements. This is not automatically a list of current prefixes.

For the initial ASN search, parse timestamps as UTC, set `at = min(query_endtime, latest_time)`, and retain prefixes with at least one timeline satisfying `starttime <= at <= endtime`. The recorded AS13335 response yields 5,272 such prefixes. Filter before sorting/limiting. Inclusive end comparison is appropriate here because the latest observed sample is returned as the timeline end; this is a search snapshot interpretation, not a replacement for event-based route replay. Label the result “Prefixes observed at [time]” and expose the visibility threshold. If requesting a narrower period, still trust returned query bounds and latest time instead of the wall clock. For replay-specific search, target its timestamp explicitly. Do not silently pick a historical prefix that is absent at the selected snapshot.

### Company text → candidate ASNs

[Searchcomplete documentation](https://stat.ripe.net/docs/data-api/api-endpoints/searchcomplete/), [verified request](https://stat.ripe.net/data/searchcomplete/data.json?resource=google):

```json
{"categories":[{"category":"ASNs","suggestions":[{"label":"AS15169","value":"AS15169","description":"GOOGLE - Google LLC"}]}],"query_term":"google","limit":50}
```

This excerpt omits other suggestions/categories. Filter to category `ASNs` and validate each `value`. Google returns many ASNs. `ST DIGITAL` returns AS37790, AS328840, AS328913, and AS328995 with the same description: users must be able to distinguish them by ASN. Suggestions are name matches, not an authoritative company-to-all-networks registry. Ignore domain popularity descriptions (the verified API returned historical Alexa references). Set an explicit `limit`: current documentation says default six, whereas the verified response reports 50; do not rely on that default or a fixed endpoint version.

## Recommended v1 mapping

| Input | Resolution | User-visible result |
| --- | --- | --- |
| IP | Validate IPv4/IPv6; Network Info; optionally AS Overview for all origins | Original address, observed containing prefix, all origin ASNs, observation freshness |
| Prefix | Normalize with Python `ipaddress.ip_network`; keep explicit CIDR as the routing query | Exact selected prefix; do not infer whole-prefix coverage from one address |
| ASN | Accept `AS123` or an unambiguous integer; AS Overview plus Announced Prefixes | Named network and selectable prefixes observed at the source snapshot |
| Company | Searchcomplete ASN candidates; then ASN flow | Disambiguation list with holder and ASN, followed by prefix selection |
| Domain | Resolve A/AAAA through system DNS, then Network Info per unique public address | Domain → DNS address → observed prefix/ASN; preserve multiple answers |

Domain DNS resolution is a separate implementation step, not supported by Network Info. Record retrieval time and explain resolver/location dependence. A domain may use third-party hosting/CDNs; its serving network is not necessarily the company's own network. Prefer showing multiple answers rather than silently choosing the first. Do not fetch arbitrary domain HTTP URLs for this routing task.

Return bounded result lists with explicit truncation metadata; debounce search and avoid requesting thousands of prefix histories merely to populate suggestions. Separate search resolution from loading the selected prefix's routing evidence. Show external-service failures as failures, and successful no-match results as no match. Do not substitute invented routes or a favorite destination.

## Reproducible evidence

Raw successful API envelopes are in `backend/tests/recordings/entity-search/`, with exact URLs in that directory's README. They are historical captures for offline tests, not application fallback data. Source timestamps are preserved so tests can distinguish data retrieval from observation time.
