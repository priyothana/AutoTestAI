from sqlalchemy import Column, String, ForeignKey, DateTime, Text
from sqlalchemy.dialects.postgresql import UUID, JSONB
import uuid
from datetime import datetime
from .base import Base


class RagQueryLog(Base):
    __tablename__ = "rag_query_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    test_case_id = Column(UUID(as_uuid=True), ForeignKey("test_cases.id"), nullable=True)
    query_text = Column(Text, nullable=False)
    retrieved_chunks = Column(JSONB, default=[])
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
