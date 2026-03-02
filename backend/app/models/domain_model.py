from sqlalchemy import Column, String, ForeignKey, DateTime
from sqlalchemy.dialects.postgresql import UUID, JSONB
import uuid
from datetime import datetime
from .base import Base


class DomainModel(Base):
    __tablename__ = "domain_models"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    entity_name = Column(String, nullable=False)
    actions = Column(JSONB, default=[])       # e.g. ["create", "edit", "submit_for_approval"]
    testing_rules = Column(JSONB, default=[]) # e.g. ["mandatory_field_test", "negative_test"]
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
