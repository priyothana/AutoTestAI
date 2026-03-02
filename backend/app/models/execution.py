from sqlalchemy import Column, String, ForeignKey, DateTime, Text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import uuid
from app.db.base import Base

class Execution(Base):
    __tablename__ = "executions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    
    test_case_id = Column(UUID(as_uuid=True), ForeignKey("test_cases.id"))
    
    status = Column(String, default="PENDING") # PENDING, RUNNING, PASSED, FAILED
    logs = Column(Text, nullable=True)
    result_metadata = Column(JSONB, nullable=True) # Duration, browser info, etc.
    
    started_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)
    
    test_case = relationship("TestCase", backref="executions")
