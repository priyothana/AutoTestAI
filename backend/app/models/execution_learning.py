"""
Execution Learning Model
Stores structured learning records from test execution results
to enable self-improving RAG-based test step generation.
"""
from sqlalchemy import Column, String, ForeignKey, DateTime, Text
from sqlalchemy.dialects.postgresql import UUID, JSONB
import uuid
from datetime import datetime
from .base import Base


class ExecutionLearning(Base):
    __tablename__ = "execution_learnings"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    test_case_id = Column(UUID(as_uuid=True), ForeignKey("test_cases.id"), nullable=True)
    test_run_id = Column(UUID(as_uuid=True), ForeignKey("test_runs.id"), nullable=True)

    # Learning classification
    learning_type = Column(String, nullable=False)  # success_pattern, failure_correction, field_behavior

    # Salesforce context
    object_name = Column(String, nullable=True)       # e.g. Invoice__c
    field_name = Column(String, nullable=True)         # e.g. Bank Detail
    field_type = Column(String, nullable=True)         # e.g. lookup, picklist

    # Action correction
    action_attempted = Column(String, nullable=True)   # e.g. TYPE
    correct_action = Column(String, nullable=True)     # e.g. LOOKUP_SELECT
    failure_reason = Column(Text, nullable=True)       # Error message or description

    # Successful pattern storage
    steps_pattern = Column(JSONB, nullable=True)       # Full successful step sequence
    extra_metadata = Column(JSONB, nullable=True)      # Additional context

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
