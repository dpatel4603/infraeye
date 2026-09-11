from contextlib import asynccontextmanager
from typing import Literal
import httpx
from .atlas import AtlasSource
from .search import EntitySearch, public_prefix
from fastapi import FastAPI, HTTPException, Query
from .source import ROOT, RESOURCES, RipeSource, RouteSource, reconstruct, change_history


def create_app(source: RouteSource | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.search = EntitySearch()
        app.state.source = source or RipeSource(ROOT / "backend/data/ripe.sqlite3")
        app.state.atlas = AtlasSource(ROOT / "backend/data/ripe.sqlite3")
        yield

    app = FastAPI(title="InfraEye — RIPE RIS routing observations", lifespan=lifespan)

    def validate_resource(resource: str):
        try:
            return public_prefix(resource)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

    async def capture(resource: str, dataset_id: str | None = None):
        resource = validate_resource(resource)
        if dataset_id:
            result = app.state.source.read(resource)
            if not result or result["metadata"]["dataset_id"] != dataset_id:
                raise HTTPException(409, "Capture refreshed. Reload metadata before replaying.")
            return result
        try:
            return await app.state.source.load(resource)
        except RuntimeError as error:
            raise HTTPException(503, str(error)) from error

    @app.get("/api/search")
    async def search(q: str = Query(..., min_length=1, max_length=253)):
        try:
            return await app.state.search.resolve(q)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        except (httpx.HTTPError, KeyError, TypeError) as error:
            raise HTTPException(502, "The public lookup service is unavailable. Try again later.") from error

    @app.get("/api/atlas")
    async def atlas(target: str = Query(..., max_length=45), at: int = Query(..., ge=3600),
                    asn: int | None = Query(None, ge=1, le=4294967295), probe_id: int | None = Query(None, ge=1)):
        try:
            return await app.state.atlas.load(target, at, asn, probe_id)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        except (httpx.HTTPError, KeyError, TypeError) as error:
            raise HTTPException(502, "RIPE Atlas measurements are unavailable. Try again later.") from error

    @app.get("/api/metadata")
    async def metadata(resource: str = RESOURCES[0]):
        return (await capture(resource))["metadata"]

    @app.get("/api/events")
    async def events(resource: str = RESOURCES[0], at: int | None = None,
                     type: Literal["announcement", "withdrawal"] | None = None,
                     peer_id: str | None = None, prefix: str | None = None):
        data = await capture(resource)
        return [e for e in data["events"] if (at is None or e["timestamp"] <= at)
                and (type is None or e["type"] == type) and (peer_id is None or e["peer_id"] == peer_id)
                and (prefix is None or e["prefix"] == prefix)]

    @app.get("/api/state")
    async def state(at: int = Query(...), resource: str = RESOURCES[0], dataset_id: str | None = None):
        data = await capture(resource, dataset_id)
        meta = data["metadata"]
        if not meta["start"] <= at <= meta["end"]:
            raise HTTPException(422, "Timestamp outside the recorded coverage window")
        return {"timestamp": at, "data_label": meta["data_label"], "dataset_id": meta["dataset_id"],
                "routes": reconstruct(data["events"], at, data["initial"]),
                "events": change_history(data["events"], data["initial"])}

    return app


app = create_app()
