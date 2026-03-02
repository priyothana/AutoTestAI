from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import List, Optional
import os
from openai import AsyncOpenAI
import json
from app.services.ai_service import AIService, MODEL_PROVIDERS

router = APIRouter()

class TestGenerationRequest(BaseModel):
    prompt: str
    provider: str = "openai"    # "openai" or "claude"
    model: Optional[str] = None  # e.g. "gpt-4o", "claude-3-5-sonnet-20241022"

class TestGenerationResponse(BaseModel):
    name: str
    description: str
    steps: List[str]
    priority: str
    preconditions: List[str] = []
    expected_outcome: str

@router.post("/generate-test-steps", response_model=TestGenerationResponse)
async def generate_test_steps(request: TestGenerationRequest):
    try:
        result = await AIService.generate_test_case(
            prompt=request.prompt,
            provider=request.provider,
            model=request.model,
        )
        return TestGenerationResponse(**result)
    except Exception as e:
        print(f"Error generating test: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/models")
async def list_available_models():
    """Return the list of supported model providers and their available models."""
    return MODEL_PROVIDERS
