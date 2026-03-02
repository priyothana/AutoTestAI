from pydantic import BaseModel
from uuid import UUID
from typing import List, Optional, Any, Dict
from datetime import datetime


# --- Salesforce Connection ---

class SalesforceConnectionCreate(BaseModel):
    project_id: UUID
    instance_url: str
    access_token: str
    refresh_token: Optional[str] = None
    org_name: Optional[str] = None


class SalesforceConnectionResponse(BaseModel):
    id: UUID
    project_id: UUID
    instance_url: str
    org_name: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


# --- Metadata Extraction ---

class MetadataExtractRequest(BaseModel):
    project_id: UUID
    force_refresh: bool = False  # if True, re-extract even if metadata exists


class MetadataStatusResponse(BaseModel):
    project_id: UUID
    has_metadata: bool
    raw_count: int = 0
    normalized_count: int = 0
    domain_model_count: int = 0
    embedding_count: int = 0
    last_extracted_at: Optional[datetime] = None


# --- RAG Generate ---

class RAGGenerateRequest(BaseModel):
    project_id: UUID
    prompt: str
    test_case_id: Optional[UUID] = None
    top_k: int = 5  # number of relevant chunks to retrieve
    provider: str = "openai"    # "openai" or "claude"
    model: Optional[str] = None  # specific model name override


class RAGGenerateResponse(BaseModel):
    name: str
    description: str
    steps: List[Dict[str, Any]]
    priority: str
    preconditions: List[str] = []
    expected_outcome: str
    rag_context_used: bool = False
    retrieved_chunks: List[str] = []
    model_provider: str = "openai"
