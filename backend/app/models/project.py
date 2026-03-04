from sqlalchemy import Column, Integer, String, Boolean, ForeignKey, Text, JSON, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
import uuid
from .base import Base, TimestampMixin

class Project(Base, TimestampMixin):
    __tablename__ = "projects"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    type = Column(String, nullable=False) # web, mobile, api, salesforce, etc.
    category = Column(String(20), default="webapp")  # salesforce / webapp / api / other
    base_url = Column(String, nullable=True)
    status = Column(String, default="Active") # Active, Draft, Archived
    tags = Column(JSON, default=list) # Array of strings
    members = Column(JSON, default=list) # Array of {userId, role}
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True)

    # Salesforce UI session tracking
    ui_session_active = Column(Boolean, default=False)
    ui_session_last_created_at = Column(DateTime, nullable=True)
    ui_session_source = Column(String(20), nullable=True)  # 'oauth' | 'login_test'
    
    owner = relationship("User", back_populates="projects")
    test_cases = relationship("TestCase", back_populates="project")
    environments = relationship("Environment", back_populates="project")
    test_data_sets = relationship("TestDataSet", back_populates="project")
    integrations = relationship("Integration", back_populates="project")
