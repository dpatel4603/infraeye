"""Resolve public IPs, prefixes, ASNs, company names and domains through real sources."""
import asyncio
import ipaddress
import re
import socket
import time

import httpx

BASE = "https://stat.ripe.net/data"
FAVORITES = ("1.1.1.0/24", "8.8.8.0/24", "9.9.9.0/24")


def public_prefix(value: str) -> str:
    network = ipaddress.ip_network(value, strict=True)
    if not network.network_address.is_global or network.is_multicast:
        raise ValueError("Search a publicly routed Internet address or prefix.")
    if network.prefixlen < (16 if network.version == 4 else 32):
        raise ValueError("Choose a smaller destination prefix (IPv4 /16 or longer; IPv6 /32 or longer).")
    return str(network)


class EntitySearch:
    def __init__(self):
        self.cache: dict[str, tuple[float, dict]] = {}

    async def api(self, client: httpx.AsyncClient, endpoint: str, resource: str) -> dict:
        params = {"resource": resource}
        if endpoint == "searchcomplete":
            params["limit"] = "12"
        response = await client.get(f"{BASE}/{endpoint}/data.json", params=params)
        response.raise_for_status()
        body = response.json()
        if body.get("status") != "ok":
            raise ValueError("RIPEstat could not resolve this search. Try again later.")
        return body["data"]

    async def network(self, client: httpx.AsyncClient, value: str) -> dict:
        info = await self.api(client, "network-info", value)
        if not info.get("prefix"):
            raise ValueError(f"RIPEstat has no routed prefix for {value}.")
        prefix = public_prefix(info["prefix"])
        asns = [int(asn) for asn in info.get("asns", [])]
        # Preserve multiple origins. An IP address does not always map to one ASN.
        entities = []
        for asn in asns[:8]:
            overview = await self.api(client, "as-overview", f"AS{asn}")
            entities.append({"kind": "network", "asn": asn, "name": overview.get("holder") or f"AS{asn}",
                             "prefix": prefix, "prefixes": [prefix], "origin_asns": asns,
                             "source_url": str(httpx.URL(f"{BASE}/network-info/data.json", params={"resource": value}))})
        if not entities:
            raise ValueError("RIPEstat returned no origin network for this address.")
        return {"results": entities, "notice": "Resolved from RIPEstat routing snapshots, which can be delayed by hours. Replay may cover an earlier window."}

    async def autonomous_system(self, client: httpx.AsyncClient, asn: int) -> dict:
        if not 0 < asn <= 4294967295:
            raise ValueError("Enter an ASN between 1 and 4294967295.")
        overview, announced = await asyncio.gather(
            self.api(client, "as-overview", f"AS{asn}"),
            self.api(client, "announced-prefixes", f"AS{asn}"),
        )
        # Latest RIPE observation time, not wall-clock time, defines current here.
        bounds = [announced[key] for key in ("latest_time", "query_endtime") if announced.get(key)]
        latest = min(bounds) if bounds else None
        candidates = []
        for item in announced.get("prefixes", []):
            if latest and not any(t["starttime"] <= latest <= t["endtime"] for t in item.get("timelines", [])):
                continue
            try:
                candidates.append(public_prefix(item["prefix"]))
            except ValueError:
                continue
        candidates = sorted(set(candidates), key=lambda p: (p not in FAVORITES, ipaddress.ip_network(p).version, p))
        return {"results": [{"kind": "network", "asn": asn, "name": overview.get("holder") or f"AS{asn}",
                              "prefixes": candidates[:30], "prefix_count": len(candidates),
                              "origin_asns": [asn], "source_url": f"{BASE}/announced-prefixes/data.json?resource=AS{asn}"}],
                "notice": "Choose an observed prefix to explore. Up to 30 are listed; RIPEstat filters low-visibility prefixes. One ASN can serve many destinations."}

    async def resolve(self, query: str) -> dict:
        query = query.strip()
        if not query or len(query) > 253:
            raise ValueError("Enter an IP, prefix, ASN, company name or domain (up to 253 characters).")
        cached = self.cache.get(query.casefold())
        if cached and time.time() - cached[0] < 900:
            return cached[1]
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            if re.fullmatch(r"(?:AS)?\d+", query, re.IGNORECASE):
                result = await self.autonomous_system(client, int(re.sub(r"^AS", "", query, flags=re.IGNORECASE)))
            elif "/" in query:
                prefix = public_prefix(query)
                result = await self.network(client, prefix)
                if result["results"][0]["prefix"] != prefix:
                    result["notice"] = f"RIPEstat resolved {query} to the covering routed prefix shown below."
            else:
                try:
                    address = ipaddress.ip_address(query)
                except ValueError:
                    address = None
                if address is not None:
                    if not address.is_global or address.is_multicast:
                        raise ValueError("Private, reserved and local addresses have no public routing view here.")
                    result = await self.network(client, str(address))
                elif re.fullmatch(r"(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}\.?", query):
                    try:
                        answers = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(query, None, type=socket.SOCK_STREAM), timeout=10)
                    except (socket.gaierror, asyncio.TimeoutError) as error:
                        raise ValueError("This domain could not be resolved by the backend's DNS resolver.") from error
                    addresses = sorted({answer[4][0] for answer in answers}, key=lambda ip: (ipaddress.ip_address(ip).version, ip))
                    results = []
                    for ip in addresses[:4]:
                        address = ipaddress.ip_address(ip)
                        if not address.is_global or address.is_multicast:
                            continue
                        network = await self.network(client, ip)
                        for entity in network["results"]:
                            if not any(e["prefix"] == entity["prefix"] and e["asn"] == entity["asn"] for e in results):
                                results.append({**entity, "resolved_address": ip})
                    if not results:
                        raise ValueError("This domain has no public routed address available to explore.")
                    result = {"results": results, "notice": f"DNS answers from this backend (cached up to 15 minutes): {', '.join(addresses[:4])}. Domains can have multiple or changing addresses; these identify hosting networks, not necessarily the domain owner."}
                else:
                    data = await self.api(client, "searchcomplete", query)
                    suggestions = [s for category in data.get("categories", []) if category.get("category") == "ASNs" for s in category.get("suggestions", [])]
                    result = {"results": [{"kind": "asn", "asn": int(s["value"][2:]), "name": s.get("description") or s["label"], "prefixes": [], "source_url": str(httpx.URL(f"{BASE}/searchcomplete/data.json", params={"resource": query}))} for s in suggestions if re.fullmatch(r"AS\d+", s.get("value", ""))][:12],
                              "notice": "Company names can match multiple networks. Showing up to 12 RIPEstat matches; select one, then choose a destination prefix."}
        result["query"] = query
        self.cache[query.casefold()] = (time.time(), result)
        return result
