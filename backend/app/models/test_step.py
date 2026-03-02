from sqlalchemy import Column, Integer, String, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
import uuid
from .base import Base, TimestampMixin

class TestStep(Base, TimestampMixin):
    __tablename__ = "test_steps"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    test_case_id = Column(UUID(as_uuid=True), ForeignKey("test_cases.id"))
    step_number = Column(Integer, nullable=False)
    action_type = Column(String, nullable=False) # click, type, assert, navigate, wait
    locator = Column(String, nullable=True) # xpath/css/id
    value = Column(String, nullable=True)
    expected = Column(String, nullable=True)
    timeout_ms = Column(Integer, default=5000)

    test_case = relationship("TestCase", back_populates="test_steps")
