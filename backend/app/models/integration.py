from sqlalchemy import Column, Integer, String, Boolean, ForeignKey, JSON
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
import uuid
from .base import Base, TimestampMixin

class Integration(Base, TimestampMixin):
    __tablename__ = "integrations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    type = Column(String, nullable=False) # jira, asana, slack, browserstack
    config = Column(JSON, nullable=False) # api_key, webhook_url, etc
    is_active = Column(Boolean, default=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"))

    project = relationship("Project", back_populates="integrations")
