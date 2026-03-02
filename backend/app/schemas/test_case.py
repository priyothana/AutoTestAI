from pydantic import BaseModel
from uuid import UUID
from typing import List, Optional, Any

from datetime import datetime

class StepModel(BaseModel):
    id: str
    action: str
    target: Optional[str] = ""
    value: Optional[str] = ""

class TestCaseBase(BaseModel):
    name: str
    description: Optional[str] = None
    steps: List[StepModel] = []
    priority: str = "medium"
    status: Optional[str] = "draft"

class TestCaseCreate(TestCaseBase):
    project_id: UUID

class TestCaseResponse(TestCaseBase):
    id: UUID
    project_id: UUID
    project_name: Optional[str] = None
    created_at: datetime
    
    class Config:
        from_attributes = True
