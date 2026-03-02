from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import List, Dict, Any
from uuid import UUID
import openai

from app.db.session import get_db
from app.models.test_case import TestCase
from app.schemas.test_case import TestCaseCreate, TestCaseResponse, StepModel
from app.services.ai_service import AIService

router = APIRouter()

@router.post("/generate-test-steps", response_model=Dict[str, Any])
async def generate_test_steps_endpoint(prompt_data: Dict[str, str]):
    prompt = prompt_data.get("prompt")
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")

    provider = prompt_data.get("provider", "openai")
    model = prompt_data.get("model")

    try:
        test_case = await AIService.generate_test_case(prompt, provider=provider, model=model)
        return test_case
    except openai.RateLimitError:
        raise HTTPException(
            status_code=429, 
            detail="OpenAI API Quota Exceeded. Please check your billing details or API key credits."
        )
    except openai.APIError as e:
        raise HTTPException(status_code=502, detail=f"OpenAI API returned an error: {e.message}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal Server Error: {str(e)}")

from app.models.project import Project

@router.post("/", response_model=TestCaseResponse)
async def create_test(test: TestCaseCreate, db: AsyncSession = Depends(get_db)):
    new_test = TestCase(
        name=test.name,
        description=test.description,
        project_id=test.project_id,
        steps=[step.dict() for step in test.steps],
        priority=test.priority
    )
    
    db.add(new_test)
    await db.commit()
    await db.refresh(new_test)
    
    # Load project name
    result = await db.execute(select(Project.name).where(Project.id == new_test.project_id))
    new_test.project_name = result.scalar_one_or_none()
    
    return new_test

@router.get("/", response_model=List[TestCaseResponse])
async def list_tests(skip: int = 0, limit: int = 100, db: AsyncSession = Depends(get_db)):
    query = select(TestCase, Project.name.label("project_name")).join(Project, TestCase.project_id == Project.id).offset(skip).limit(limit)
    result = await db.execute(query)
    tests_with_projects = result.all()
    
    response = []
    for test, project_name in tests_with_projects:
        test.project_name = project_name
        response.append(test)
    return response

@router.get("/{id}", response_model=TestCaseResponse)
async def get_test(id: UUID, db: AsyncSession = Depends(get_db)):
    query = select(TestCase, Project.name.label("project_name")).join(Project, TestCase.project_id == Project.id).where(TestCase.id == id)
    result = await db.execute(query)
    test_data = result.first()
    
    if not test_data:
        raise HTTPException(status_code=404, detail="Test case not found")
    
    test, project_name = test_data
    test.project_name = project_name
    return test

@router.put("/{id}", response_model=TestCaseResponse)
async def update_test(id: UUID, test_update: TestCaseCreate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TestCase).where(TestCase.id == id))
    test = result.scalars().first()
    if not test:
        raise HTTPException(status_code=404, detail="Test case not found")
    
    test.name = test_update.name
    test.description = test_update.description
    test.project_id = test_update.project_id
    test.steps = [step.dict() for step in test_update.steps]
    test.priority = test_update.priority
    
    await db.commit()
    await db.refresh(test)
    return test

@router.delete("/{id}", status_code=204)
async def delete_test(id: UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TestCase).where(TestCase.id == id))
    test = result.scalars().first()
    if not test:
        raise HTTPException(status_code=404, detail="Test case not found")
    
    await db.delete(test)
    await db.commit()
    return None
