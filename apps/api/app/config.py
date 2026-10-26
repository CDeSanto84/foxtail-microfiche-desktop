from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Foxtail Microfiche API"
    database_url: str = "postgresql+asyncpg://foxtail:change-me-local-only@db:5432/foxtail_microfiche"
    api_host: str = "0.0.0.0"
    api_port: int = 8787

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
