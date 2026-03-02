from pydantic import BaseModel
from uuid import UUID
from typing import List, Optional, Any
from datetime import datetime

class TestRunBase(BaseModel):
    test_case_id: UUID

class TestRunCreate(TestRunBase):
    pass

class TestRunResponse(TestRunBase):
    id: UUID
    status: str
    result: Optional[str] = None
    duration: Optional[float] = None
    logs: List[Any] = []
    screenshot_path: Optional[str] = None
    test_case_name: Optional[str] = None
    created_at: datetime
    
    class Config:
        from_attributes = True
