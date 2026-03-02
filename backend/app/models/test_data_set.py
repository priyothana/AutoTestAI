from sqlalchemy import Column, Integer, String, ForeignKey, JSON
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
import uuid
from .base import Base, TimestampMixin

class TestDataSet(Base, TimestampMixin):
    __tablename__ = "test_data_sets"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    name = Column(String, nullable=False)
    data = Column(JSON, nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"))

    project = relationship("Project", back_populates="test_data_sets")
