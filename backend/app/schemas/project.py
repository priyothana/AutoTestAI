from pydantic import BaseModel
from uuid import UUID
from typing import Optional, List
from datetime import datetime

class ProjectBase(BaseModel):
    name: str
    description: Optional[str] = None
    type: str # WEB, MOBILE, API, SALESFORCE
    category: Optional[str] = "webapp"  # salesforce / webapp / api / other
    base_url: Optional[str] = None
    status: Optional[str] = "Active"
    tags: Optional[List[str]] = []

class ProjectCreate(ProjectBase):
    pass

class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    type: Optional[str] = None
    category: Optional[str] = None
    base_url: Optional[str] = None
    status: Optional[str] = None
    tags: Optional[List[str]] = None

class ProjectResponse(ProjectBase):
    id: UUID
    owner_id: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime
    
    class Config:
        from_attributes = True

