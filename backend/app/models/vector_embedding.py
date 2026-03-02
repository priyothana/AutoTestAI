from sqlalchemy import Column, String, ForeignKey, DateTime, Text
from sqlalchemy.dialects.postgresql import UUID, JSONB
import uuid
from datetime import datetime
from .base import Base


class VectorEmbedding(Base):
    __tablename__ = "vector_embeddings"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    source_type = Column(String, nullable=False)  # object, flow, lwc, validation
    source_id = Column(UUID(as_uuid=True), nullable=False)
    embedding_vector = Column(JSONB, nullable=False)  # stored as JSON float array
    text_chunk = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
