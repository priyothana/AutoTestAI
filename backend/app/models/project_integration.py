from sqlalchemy import Column, String, Text, ForeignKey, DateTime, JSON, Boolean
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
import uuid
from datetime import datetime
from .base import Base, TimestampMixin


class ProjectIntegration(Base, TimestampMixin):
    __tablename__ = "project_integrations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)

    # Integration type
    category = Column(String(20), nullable=False)  # 'web_app' or 'salesforce'
    status = Column(String(20), default="disconnected")  # connected / disconnected / error / syncing

    # Common
    base_url = Column(Text, nullable=True)
    login_strategy = Column(String(50), nullable=True)  # form / basic_auth / sso / none

    # Web App Auth (encrypted)
    username = Column(Text, nullable=True)
    password = Column(Text, nullable=True)

    # Salesforce OAuth (encrypted)
    instance_url = Column(Text, nullable=True)
    client_id = Column(Text, nullable=True)
    client_secret = Column(Text, nullable=True)
    access_token = Column(Text, nullable=True)
    refresh_token = Column(Text, nullable=True)
    token_expiry = Column(DateTime, nullable=True)

    # Per-project Salesforce Connected App
    salesforce_redirect_uri = Column(Text, nullable=True)
    salesforce_login_url = Column(Text, default="https://login.salesforce.com")
    org_id = Column(Text, nullable=True)

    # MCP Server fields
    security_token = Column(Text, nullable=True)  # Salesforce security token (encrypted)
    mcp_connected = Column(Boolean, default=False)  # True when connected via MCP (not OAuth)

    # Flexible auth config (API keys, bearer tokens, etc.)
    auth_config = Column(JSON, nullable=True)

    # Sync tracking
    last_synced_at = Column(DateTime, nullable=True)
    sync_error = Column(Text, nullable=True)

    project = relationship("Project", backref="project_integrations")
