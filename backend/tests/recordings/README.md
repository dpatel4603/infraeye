# Recorded RIPE response used by tests

`ripe-bgplay-20260911.json` is the unmodified public response retrieved September 11, 2026 from:

https://stat.ripe.net/data/bgplay/data.json?resource=1.1.1.0%2F24&rrcs=00

It contains actual RIPE RIS observations, source metadata and query identity. It is used only for offline regression tests. The application never reads this directory or uses it as fallback data. Test cases that corrupt a copied response check validation only.
