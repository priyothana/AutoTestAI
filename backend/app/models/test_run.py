from sqlalchemy import Column, String, ForeignKey, Text, JSON, DateTime, Integer, Float
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
import uuid
from datetime import datetime
from .base import Base

class TestRun(Base):
    __tablename__ = "test_runs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    test_case_id = Column(UUID(as_uuid=True), ForeignKey("test_cases.id"), nullable=False)
    status = Column(String, default="pending") # pending, running, passed, failed, error
    logs = Column(JSON, default=[]) # array of log objects
    result = Column(String, nullable=True) # overall result
    duration = Column(Float, nullable=True) # in seconds
    screenshot_path = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    test_case = relationship("TestCase", back_populates="test_runs")
