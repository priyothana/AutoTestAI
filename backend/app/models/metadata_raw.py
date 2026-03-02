from sqlalchemy import Column, String, ForeignKey, DateTime, Text
from sqlalchemy.dialects.postgresql import UUID, JSONB
import uuid
from datetime import datetime
from .base import Base


class MetadataRaw(Base):
    __tablename__ = "metadata_raw_store"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    metadata_type = Column(String, nullable=False)  # object, field, flow, lwc, validation_rule
    api_name = Column(String, nullable=False)
    raw_json = Column(JSONB, default={})
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
