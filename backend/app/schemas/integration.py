from pydantic import BaseModel
from uuid import UUID
from typing import Optional
from datetime import datetime


# ─── Connect Request Schemas ─────────────────

class WebAppConnectRequest(BaseModel):
    category: str = "web_app"
    base_url: str
    username: Optional[str] = None
    password: Optional[str] = None
    login_strategy: str = "form"  # form / basic_auth / sso / none


class SalesforceConnectRequest(BaseModel):
    category: str = "salesforce"
    client_id: Optional[str] = None  # if user supplies their own Connected App
    client_secret: Optional[str] = None


# ─── Status / Response Schemas ───────────────

class IntegrationStatusResponse(BaseModel):
    id: UUID
    project_id: UUID
    category: str
    status: str
    base_url: Optional[str] = None
    instance_url: Optional[str] = None
    login_strategy: Optional[str] = None
    org_id: Optional[str] = None
    salesforce_login_url: Optional[str] = None
    last_synced_at: Optional[datetime] = None
    sync_error: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class SalesforceCredentialsRequest(BaseModel):
    """Save Connected App credentials before triggering OAuth."""
    client_id: str
    client_secret: str
    redirect_uri: Optional[str] = None  # auto-generated if empty
    login_url: Optional[str] = "https://login.salesforce.com"
    sf_username: Optional[str] = None
    sf_password: Optional[str] = None


class ApiKeyConnectRequest(BaseModel):
    """Connect an API project with key/bearer token."""
    category: str = "api"
    api_key: Optional[str] = None
    bearer_token: Optional[str] = None
    base_url: Optional[str] = None


class MetadataSyncResponse(BaseModel):
    status: str  # completed / error / no_integration
    message: str
    raw_count: int = 0
    normalized_count: int = 0
    domain_model_count: int = 0
    embedding_count: int = 0


# ─── MCP Server Request Schemas ──────────────

class McpConnectRequest(BaseModel):
    """Connect to Salesforce via MCP Server (Username + Password + Security Token)."""
    sf_username: str
    sf_password: str
    sf_security_token: str
    domain: Optional[str] = "login"  # 'login' for production, 'test' for sandbox


class McpQueryRequest(BaseModel):
    """Execute a SOQL query via MCP."""
    query: str
    include_deleted: bool = False


class McpRecordRequest(BaseModel):
    """Create or update a Salesforce record via MCP."""
    data: dict


class McpSearchRequest(BaseModel):
    """Execute a SOSL search via MCP."""
    search_query: str
