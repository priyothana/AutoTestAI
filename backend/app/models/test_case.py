from sqlalchemy import Column, Integer, String, ForeignKey, Text, JSON
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
import uuid
from .base import Base, TimestampMixin

class TestCase(Base, TimestampMixin):
    __tablename__ = "test_cases"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    steps = Column(JSON, nullable=False, default=[]) # array of step objects
    expected_result = Column(Text, nullable=True)
    priority = Column(String, default="medium") # low, medium, high
    status = Column(String, default="draft") # draft, passed, failed
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"))
    
    project = relationship("Project", back_populates="test_cases")
    test_steps = relationship("TestStep", back_populates="test_case", cascade="all, delete-orphan")
    test_runs = relationship("TestRun", back_populates="test_case", cascade="all, delete-orphan")
