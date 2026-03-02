from sqlalchemy import Column, String, ForeignKey, DateTime
from sqlalchemy.dialects.postgresql import UUID
import uuid
from datetime import datetime
from .base import Base


class SalesforceConnection(Base):
    __tablename__ = "salesforce_connections"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    instance_url = Column(String, nullable=False)
    access_token = Column(String, nullable=False)  # encrypted
    refresh_token = Column(String, nullable=True)   # encrypted, optional
    org_name = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
