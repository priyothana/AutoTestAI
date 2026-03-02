from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional

class Settings(BaseSettings):
    PROJECT_NAME: str = "AutoTest AI"
    API_V1_STR: str = "/api/v1"

    # Database
    POSTGRES_USER: str = "postgres"
    POSTGRES_PASSWORD: str = "postgres"
    POSTGRES_SERVER: str = Field("db", env="POSTGRES_SERVER")   # can be overridden locally
    POSTGRES_PORT: str = "5432"
    POSTGRES_DB: str = "autotestdb"
    DATABASE_URL: Optional[str] = Field(None, env="DATABASE_URL")

    # Security
    SECRET_KEY: str = Field(..., env="SECRET_KEY")   # must be set in .env
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30

    # OpenAI – required for AI features
    OPENAI_API_KEY: str = Field(..., env="OPENAI_API_KEY")   # fail fast if missing

    # Anthropic / Claude (optional – for Claude model selection)
    ANTHROPIC_API_KEY: Optional[str] = Field(None, env="ANTHROPIC_API_KEY")

    # Celery
    CELERY_BROKER_URL: str = "redis://redis:6379/0"
    CELERY_RESULT_BACKEND: str = "redis://redis:6379/0"

    # Optional extras
    ENV: str = Field("development", env="ENV")
    DEBUG: bool = True

    # Salesforce Integration
    SALESFORCE_ENCRYPTION_KEY: Optional[str] = Field(None, env="SALESFORCE_ENCRYPTION_KEY")
    SALESFORCE_CLIENT_ID: Optional[str] = Field(None, env="SALESFORCE_CLIENT_ID")
    SALESFORCE_CLIENT_SECRET: Optional[str] = Field(None, env="SALESFORCE_CLIENT_SECRET")
    SALESFORCE_REDIRECT_URI: str = Field(
        "http://localhost:8000/api/v1/integrations/salesforce/callback",
        env="SALESFORCE_REDIRECT_URI",
    )

    model_config = SettingsConfigDict(
        case_sensitive=True,
        env_file=[".env", "../.env", ".env.local"],
        env_file_encoding="utf-8",
        extra="ignore",
    )

    def assemble_db_connection(self) -> str:
        if self.DATABASE_URL:
            return self.DATABASE_URL
        return (
            f"postgresql+asyncpg://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
            f"@{self.POSTGRES_SERVER}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

settings = Settings()