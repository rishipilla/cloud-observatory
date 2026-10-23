from datetime import datetime

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, field_validator


class EndpointCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    url: AnyHttpUrl
    interval_seconds: int = Field(default=60, ge=10, le=86400)
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Name must not be blank")
        return value


class EndpointUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    url: AnyHttpUrl | None = None
    interval_seconds: int | None = Field(default=None, ge=10, le=86400)
    enabled: bool | None = None

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str | None) -> str | None:
        if value is None:
            return value
        value = value.strip()
        if not value:
            raise ValueError("Name must not be blank")
        return value


class CheckRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    endpoint_id: int
    status_code: int | None
    elapsed_ms: float | None
    success: bool
    error: str | None
    checked_at: datetime


class EndpointRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    url: str
    interval_seconds: int
    enabled: bool
    created_at: datetime
    updated_at: datetime
    last_check: CheckRead | None = None


class OverviewRead(BaseModel):
    endpoints_total: int
    endpoints_healthy: int
    endpoints_failing: int
    active_incidents: int
    last_checked_at: datetime | None


class EventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    endpoint_id: int | None
    type: str
    message: str
    created_at: datetime


class ProviderStatusRead(BaseModel):
    provider: str
    indicator: str
    description: str
    updated_at: datetime | None
    components: list[dict[str, str]]
    incidents: list[dict[str, str]]


class ProviderConfiguration(BaseModel):
    id: str
    name: str
    configured: bool
    required_settings: list[str]
    note: str


class ProviderConfigurationRead(BaseModel):
    providers: list[ProviderConfiguration]
