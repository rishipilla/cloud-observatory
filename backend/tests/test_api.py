from pydantic import SecretStr

from app.config import Settings
import app.routes as routes


def create_endpoint(client, url="https://example.com"):
    return client.post("/api/endpoints", json={"name": "Example", "url": url})


def test_health_and_readiness(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.get("/api/ready").json() == {"status": "ready"}


def test_create_validate_edit_delete_endpoint(client):
    created = create_endpoint(client)
    assert created.status_code == 201
    endpoint_id = created.json()["id"]
    assert created.json()["last_check"] is None
    assert client.patch(f"/api/endpoints/{endpoint_id}", json={"name": "Updated"}).json()["name"] == "Updated"
    assert client.patch(f"/api/endpoints/{endpoint_id}", json={"url": "http://127.0.0.1"}).status_code == 422
    assert create_endpoint(client, "ftp://example.com").status_code == 422
    assert create_endpoint(client, "https://user:pass@example.com").status_code == 422
    assert client.delete(f"/api/endpoints/{endpoint_id}").status_code == 204
    assert client.get(f"/api/endpoints/{endpoint_id}/history").status_code == 404


def test_endpoint_not_found_and_validation_error_shape(client):
    missing = client.post("/api/endpoints/999/check")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "not_found"
    invalid = client.post("/api/endpoints", json={"name": "", "url": "not-a-url"})
    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "validation_error"
    whitespace_name = client.post("/api/endpoints", json={"name": "   ", "url": "https://example.com"})
    assert whitespace_name.status_code == 422
    assert whitespace_name.json()["error"]["code"] == "validation_error"
    endpoint_id = create_endpoint(client).json()["id"]
    null_update = client.patch(f"/api/endpoints/{endpoint_id}", json={"name": None})
    assert null_update.status_code == 422
    assert null_update.json()["error"]["code"] == "validation_error"


def test_overview_and_events_start_empty(client):
    assert client.get("/api/overview").json() == {
        "endpoints_total": 0,
        "endpoints_healthy": 0,
        "endpoints_failing": 0,
        "active_incidents": 0,
        "last_checked_at": None,
    }
    assert client.get("/api/events").json() == []


def test_provider_configuration_reports_presence_without_exposing_secrets(client, monkeypatch):
    monkeypatch.setattr(routes, "get_settings", lambda: Settings(
        aws_access_key_id=SecretStr("aws-secret-id"),
        aws_secret_access_key=SecretStr("aws-secret-key"),
        google_cloud_project_id="sample-project",
        google_application_credentials="C:/secure/service-account.json",
        cloudflare_api_token=SecretStr("cf-secret-token"),
        cloudflare_account_id="account-id",
        external_api_key=SecretStr("external-secret"),
        external_api_base_url="https://api.example.com",
    ))
    response = client.get("/api/providers/config")
    assert response.status_code == 200
    body = response.text
    assert "aws-secret-key" not in body
    assert "cf-secret-token" not in body
    assert "external-secret" not in body
    assert all(provider["configured"] for provider in response.json()["providers"])
