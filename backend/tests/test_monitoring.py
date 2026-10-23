import asyncio
import tempfile
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.database import Base, build_engine
from app.models import CheckResult, Endpoint, MonitoringEvent
from app.services import monitoring
from app.services.monitoring import ProhibitedDestination, validate_url


def add_endpoint(client):
    response = client.post("/api/endpoints", json={"name": "Probe", "url": "https://example.com"})
    return response.json()["id"]


def test_successful_check_persists_history_and_response_time(client, monkeypatch):
    async def fake_request(_url):
        return 200, 12.5

    monkeypatch.setattr(monitoring, "request_status", fake_request)
    endpoint_id = add_endpoint(client)
    result = client.post(f"/api/endpoints/{endpoint_id}/check")
    assert result.status_code == 200
    assert result.json()["success"] is True
    assert result.json()["elapsed_ms"] == 12.5
    assert client.get(f"/api/endpoints/{endpoint_id}/history").json()[0]["status_code"] == 200
    assert client.get("/api/overview").json()["endpoints_healthy"] == 1
    assert client.get("/api/events").json() == []


def test_failed_check_and_recovery_generate_real_events(client, monkeypatch):
    attempts = iter([(503, 4.0), (200, 5.0)])

    async def fake_request(_url):
        return next(attempts)

    monkeypatch.setattr(monitoring, "request_status", fake_request)
    endpoint_id = add_endpoint(client)
    failed = client.post(f"/api/endpoints/{endpoint_id}/check").json()
    recovered = client.post(f"/api/endpoints/{endpoint_id}/check").json()
    assert failed["success"] is False
    assert failed["error"] == "HTTP 503"
    assert recovered["success"] is True
    assert [event["type"] for event in client.get("/api/events").json()] == ["recovery", "failure"]


def test_timeout_is_recorded_as_a_failure(client, monkeypatch):
    async def fake_request(_url):
        raise asyncio.TimeoutError()

    monkeypatch.setattr(monitoring, "request_status", fake_request)
    endpoint_id = add_endpoint(client)
    result = client.post(f"/api/endpoints/{endpoint_id}/check").json()
    assert result["success"] is False
    assert result["status_code"] is None
    assert result["error"] == "Request timed out"


def test_database_data_survives_session_reopen(client, monkeypatch):
    async def fake_request(_url):
        return 204, 2.0

    monkeypatch.setattr(monitoring, "request_status", fake_request)
    endpoint_id = add_endpoint(client)
    client.post(f"/api/endpoints/{endpoint_id}/check")
    assert client.get("/api/endpoints").json()[0]["last_check"]["success"] is True


def test_file_database_persists_endpoint_checks_and_events(monkeypatch):
    async def failed_request(_url):
        return 503, 8.0

    monkeypatch.setattr(monitoring, "request_status", failed_request)
    with tempfile.NamedTemporaryFile(suffix=".sqlite", dir=Path(__file__).parent, delete=False) as file:
        database_file = Path(file.name)
    engine = build_engine(f"sqlite:///{database_file}")
    try:
        Base.metadata.create_all(bind=engine)
        Session = sessionmaker(bind=engine, expire_on_commit=False)
        with Session() as db:
            endpoint = Endpoint(name="Persistent", url="https://example.com", interval_seconds=60, enabled=True)
            db.add(endpoint)
            db.commit()
            db.refresh(endpoint)
            asyncio.run(monitoring.monitoring_service.check_endpoint(db, endpoint))
            endpoint_id = endpoint.id
        with Session() as db:
            assert db.get(Endpoint, endpoint_id) is not None
            assert db.scalar(select(CheckResult).where(CheckResult.endpoint_id == endpoint_id)).error == "HTTP 503"
            event = db.scalar(select(MonitoringEvent).where(MonitoringEvent.endpoint_id == endpoint_id))
            assert event.type == "failure"
            db.delete(db.get(Endpoint, endpoint_id))
            db.commit()
            db.expire(event)
            assert db.get(MonitoringEvent, event.id).endpoint_id is None
    finally:
        engine.dispose()
        database_file.unlink(missing_ok=True)


def test_private_literal_and_prohibited_redirect_destinations():
    for url in ("http://127.0.0.1", "http://10.1.2.3", "http://169.254.1.1", "http://[::1]", "http://localhost"):
        with pytest.raises(ProhibitedDestination):
            validate_url(url)
    validate_url("https://example.com")
    with pytest.raises(ProhibitedDestination):
        validate_url("http://192.168.0.2")


def test_resolver_rejects_private_dns_resolution(monkeypatch):
    async def fake_getaddrinfo(*_args, **_kwargs):
        return [(2, 1, 6, "", ("10.0.0.10", 80))]

    monkeypatch.setattr(asyncio, "get_running_loop", lambda: type("Loop", (), {"getaddrinfo": fake_getaddrinfo})())
    from app.services.monitoring import PublicResolver

    with pytest.raises(ProhibitedDestination):
        asyncio.run(PublicResolver().resolve("rebind.example", 80))


def test_redirect_to_private_destination_is_blocked(monkeypatch):
    class FakeResponse:
        status = 302
        headers = {"Location": "http://127.0.0.1/admin"}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def get(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr(monitoring.aiohttp, "ClientSession", lambda **_kwargs: FakeClient())
    with pytest.raises(ProhibitedDestination):
        asyncio.run(monitoring.request_status("https://example.com/redirect"))
