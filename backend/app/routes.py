from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.models import CheckResult, Endpoint, MonitoringEvent
from app.schemas import (
    CheckRead,
    EndpointCreate,
    EndpointRead,
    EndpointUpdate,
    EventRead,
    OverviewRead,
    ProviderConfiguration,
    ProviderConfigurationRead,
    ProviderStatusRead,
)
from app.services.monitoring import ProhibitedDestination, monitoring_service, request_json, validate_url


router = APIRouter(prefix="/api")


def get_endpoint_or_404(db: Session, endpoint_id: int) -> Endpoint:
    endpoint = db.get(Endpoint, endpoint_id)
    if endpoint is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Endpoint not found"})
    return endpoint


def endpoint_with_last_check(db: Session, endpoint: Endpoint) -> EndpointRead:
    last_check = db.scalar(
        select(CheckResult)
        .where(CheckResult.endpoint_id == endpoint.id)
        .order_by(CheckResult.checked_at.desc(), CheckResult.id.desc())
        .limit(1)
    )
    return EndpointRead.model_validate(endpoint).model_copy(update={"last_check": last_check})


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready")
def ready(db: Session = Depends(get_db)) -> dict[str, str]:
    try:
        db.execute(text("SELECT 1"))
    except Exception as exc:
        raise HTTPException(status_code=503, detail={"code": "database_unavailable", "message": "Database is unavailable"}) from exc
    return {"status": "ready"}


@router.get("/overview", response_model=OverviewRead)
def overview(db: Session = Depends(get_db)) -> OverviewRead:
    endpoints = db.scalars(select(Endpoint)).all()
    healthy = 0
    failing = 0
    latest_times: list[datetime] = []
    for endpoint in endpoints:
        check = db.scalar(
            select(CheckResult)
            .where(CheckResult.endpoint_id == endpoint.id)
            .order_by(CheckResult.checked_at.desc(), CheckResult.id.desc())
            .limit(1)
        )
        if check is None:
            continue
        latest_times.append(check.checked_at)
        if check.success:
            healthy += 1
        else:
            failing += 1
    return OverviewRead(
        endpoints_total=len(endpoints),
        endpoints_healthy=healthy,
        endpoints_failing=failing,
        active_incidents=failing,
        last_checked_at=max(latest_times) if latest_times else None,
    )


@router.get("/endpoints", response_model=list[EndpointRead])
def list_endpoints(db: Session = Depends(get_db)) -> list[EndpointRead]:
    return [endpoint_with_last_check(db, endpoint) for endpoint in db.scalars(select(Endpoint).order_by(Endpoint.id)).all()]


@router.post("/endpoints", response_model=EndpointRead, status_code=201)
def create_endpoint(payload: EndpointCreate, db: Session = Depends(get_db)) -> EndpointRead:
    try:
        validate_url(str(payload.url))
    except (ProhibitedDestination, ValueError) as exc:
        raise HTTPException(status_code=422, detail={"code": "prohibited_destination", "message": str(exc)}) from exc
    endpoint = Endpoint(**payload.model_dump(mode="json"))
    db.add(endpoint)
    db.commit()
    db.refresh(endpoint)
    return endpoint_with_last_check(db, endpoint)


@router.patch("/endpoints/{endpoint_id}", response_model=EndpointRead)
def update_endpoint(endpoint_id: int, payload: EndpointUpdate, db: Session = Depends(get_db)) -> EndpointRead:
    endpoint = get_endpoint_or_404(db, endpoint_id)
    changes = payload.model_dump(exclude_unset=True, mode="json")
    if any(value is None for value in changes.values()):
        raise HTTPException(status_code=422, detail={"code": "validation_error", "message": "Endpoint fields cannot be null"})
    if "url" in changes and changes["url"] is not None:
        try:
            validate_url(changes["url"])
        except (ProhibitedDestination, ValueError) as exc:
            raise HTTPException(status_code=422, detail={"code": "prohibited_destination", "message": str(exc)}) from exc
    for field, value in changes.items():
        setattr(endpoint, field, value)
    db.commit()
    db.refresh(endpoint)
    return endpoint_with_last_check(db, endpoint)


@router.delete("/endpoints/{endpoint_id}", status_code=204)
def delete_endpoint(endpoint_id: int, db: Session = Depends(get_db)) -> Response:
    endpoint = get_endpoint_or_404(db, endpoint_id)
    db.delete(endpoint)
    db.commit()
    return Response(status_code=204)


@router.post("/endpoints/{endpoint_id}/check", response_model=CheckRead)
async def check_endpoint(endpoint_id: int, db: Session = Depends(get_db)) -> CheckRead:
    endpoint = get_endpoint_or_404(db, endpoint_id)
    return await monitoring_service.check_endpoint(db, endpoint)


@router.get("/endpoints/{endpoint_id}/history", response_model=list[CheckRead])
def endpoint_history(
    endpoint_id: int,
    limit: int = Query(default=50, ge=1, le=500),
    db: Session = Depends(get_db),
) -> list[CheckResult]:
    get_endpoint_or_404(db, endpoint_id)
    return list(db.scalars(
        select(CheckResult)
        .where(CheckResult.endpoint_id == endpoint_id)
        .order_by(CheckResult.checked_at.desc(), CheckResult.id.desc())
        .limit(limit)
    ).all())


@router.get("/providers/cloudflare", response_model=ProviderStatusRead)
async def cloudflare_status() -> ProviderStatusRead:
    url = "https://www.cloudflarestatus.com/api/v2/summary.json"
    try:
        data = await request_json(url)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail={"code": "provider_unavailable", "message": "Cloudflare public status is currently unavailable"}) from exc

    status = data.get("status") or {}
    components = [
        {"name": item.get("name", "Unknown"), "status": item.get("status", "unknown")}
        for item in data.get("components", [])
    ]
    incidents = [
        {"name": item.get("name", "Incident"), "status": item.get("status", "unknown")}
        for item in data.get("incidents", [])
    ]
    updated = (data.get("page") or {}).get("updated_at")
    return ProviderStatusRead(
        provider="Cloudflare",
        indicator=status.get("indicator", "unknown"),
        description=status.get("description", "Status unavailable"),
        updated_at=datetime.fromisoformat(updated.replace("Z", "+00:00")) if updated else None,
        components=components,
        incidents=incidents,
    )


@router.get("/providers/config", response_model=ProviderConfigurationRead)
def provider_configuration() -> ProviderConfigurationRead:
    settings = get_settings()
    aws_configured = bool(settings.aws_access_key_id and settings.aws_secret_access_key)
    google_configured = bool(settings.google_cloud_project_id and settings.google_application_credentials)
    cloudflare_configured = bool(settings.cloudflare_api_token and settings.cloudflare_account_id)
    external_configured = bool(settings.external_api_key and settings.external_api_base_url)
    return ProviderConfigurationRead(providers=[
        ProviderConfiguration(
            id="aws",
            name="AWS",
            configured=aws_configured,
            required_settings=["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
            note="Use a dedicated least-privilege IAM identity; session tokens are supported.",
        ),
        ProviderConfiguration(
            id="google_cloud",
            name="Google Cloud",
            configured=google_configured,
            required_settings=["GOOGLE_CLOUD_PROJECT_ID", "GOOGLE_APPLICATION_CREDENTIALS"],
            note="Set the path to a service-account JSON file; do not paste the JSON contents here.",
        ),
        ProviderConfiguration(
            id="cloudflare",
            name="Cloudflare account API",
            configured=cloudflare_configured,
            required_settings=["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
            note="The public Cloudflare status integration works without credentials.",
        ),
        ProviderConfiguration(
            id="external",
            name="Other API",
            configured=external_configured,
            required_settings=["EXTERNAL_API_KEY", "EXTERNAL_API_BASE_URL"],
            note="Generic placeholder only; an adapter is needed for a specific API.",
        ),
    ])


@router.get("/events", response_model=list[EventRead])
def list_events(limit: int = Query(default=50, ge=1, le=500), db: Session = Depends(get_db)) -> list[MonitoringEvent]:
    return list(db.scalars(
        select(MonitoringEvent).order_by(MonitoringEvent.created_at.desc(), MonitoringEvent.id.desc()).limit(limit)
    ).all())
