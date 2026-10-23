from functools import lru_cache

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "sqlite:///./cloud_observatory.db"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    check_connect_timeout_seconds: float = 3.0
    check_total_timeout_seconds: float = 8.0
    check_max_redirects: int = 5
    aws_access_key_id: SecretStr | None = None
    aws_secret_access_key: SecretStr | None = None
    aws_session_token: SecretStr | None = None
    aws_region: str = "us-east-1"
    google_cloud_project_id: str | None = None
    google_application_credentials: str | None = None
    cloudflare_api_token: SecretStr | None = None
    cloudflare_account_id: str | None = None
    external_api_key: SecretStr | None = None
    external_api_base_url: str | None = None

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
