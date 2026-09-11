# Entity search API recordings

Unmodified successful public RIPEstat HTTPS JSON responses retrieved on 2026-09-11. These are real historical observations for deterministic offline resolver tests, not synthetic data and not application fallback data. No API key or paid service was used.

| File | Exact source URL | Response timestamp (UTC) |
| --- | --- | --- |
| `network-info.json` | https://stat.ripe.net/data/network-info/data.json?resource=8.8.8.8 | 2026-09-11T16:41:36.311851 |
| `as-overview.json` | https://stat.ripe.net/data/as-overview/data.json?resource=AS328840 | 2026-09-11T16:41:37.535621 |
| `searchcomplete.json` | https://stat.ripe.net/data/searchcomplete/data.json?resource=google | 2026-09-11T16:41:37.249585 |
| `announced-prefixes.json` | https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS13335 | 2026-09-11T16:41:37.708872 |

Keep source envelopes (including observation bounds, messages, and versions) intact. `announced-prefixes.json` contains the complete AS13335 response, including historical prefixes no longer present at its latest snapshot. See [research notes](../../../../docs/entity-search.md) for filtering semantics and documented limitations.
