from sqlalchemy import Column, String, ForeignKey, DateTime
from sqlalchemy.dialects.postgresql import UUID, JSONB
import uuid
from datetime import datetime
from .base import Base


class MetadataNormalized(Base):
    __tablename__ = "metadata_normalized"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    object_name = Column(String, nullable=False)
    entity_type = Column(String, nullable=False)  # object, field, flow, lwc, validation
    label = Column(String, nullable=True)
    structured_json = Column(JSONB, default={})
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
