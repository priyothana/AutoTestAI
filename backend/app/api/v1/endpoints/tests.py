from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import List, Dict, Any, Optional
from uuid import UUID
import openai

from app.db.session import get_db
from app.models.test_case import TestCase
from app.schemas.test_case import TestCaseCreate, TestCaseResponse, StepModel
from app.services.ai_service import AIService

router = APIRouter()

@router.post("/generate-test-steps", response_model=Dict[str, Any])
async def generate_test_steps_endpoint(
    prompt_data: Dict[str, str],
    db: AsyncSession = Depends(get_db),
):
    prompt = prompt_data.get("prompt")
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")

    provider = prompt_data.get("provider", "openai")
    model = prompt_data.get("model")
    project_id = prompt_data.get("project_id")

    # --- Gate login step generation and detect MCP projects ---
    session_instruction = ""
    use_mcp_rag = False

    if project_id:
        try:
            from app.models.project import Project
            from app.models.project_integration import ProjectIntegration
            from app.services.session_service import SessionService

            pid = UUID(project_id)
            proj_result = await db.execute(select(Project).where(Project.id == pid))
            project = proj_result.scalars().first()

            if project:
                int_result = await db.execute(
                    select(ProjectIntegration).where(ProjectIntegration.project_id == pid)
                )
                integration = int_result.scalars().first()
                is_connected = integration and integration.status == "connected"
                is_mcp = integration and getattr(integration, 'mcp_connected', False)

                # --- MCP + Metadata → Strict metadata-driven RAG generation ---
                # This check runs for ANY project category with MCP connection
                if is_mcp and is_connected:
                    from sqlalchemy import func as sa_func
                    from app.models.vector_embedding import VectorEmbedding
                    embedding_count = (await db.execute(
                        select(sa_func.count()).select_from(VectorEmbedding).where(
                            VectorEmbedding.project_id == pid
                        )
                    )).scalar_one()

                    if embedding_count > 0:
                        use_mcp_rag = True
                        print(f"[TEST-GEN] MCP project {pid} has {embedding_count} embeddings → using strict metadata RAG")
                    else:
                        session_instruction = (
                            "\n\nIMPORTANT: This is a Salesforce MCP-connected project. "
                            "DO NOT generate any login/authentication steps. The user is already authenticated. "
                            "Start the test from the Lightning home page or the relevant object page directly. "
                            "Use Salesforce Lightning URL patterns like /lightning/o/ObjectName/list."
                        )

                elif project.category == "salesforce" and is_connected:
                    session_instruction = (
                        "\n\nIMPORTANT: This is a Salesforce project with an active OAuth connection. "
                        "DO NOT generate any login/authentication steps. The user is already authenticated. "
                        "Start the test from the application's home page or the relevant object page directly."
                    )
                elif project.category == "salesforce":
                    has_session = await SessionService.has_valid_session(db, pid)
                    if has_session:
                        session_instruction = (
                            "\n\nIMPORTANT: This Salesforce project has an active browser session. "
                            "DO NOT include login/authentication steps. The session will be reused automatically. "
                            "Start the test from the Lightning home page or the relevant object page."
                        )
        except Exception as e:
            print(f"[TEST-GEN] Project detection error: {e}")
            pass  # Non-critical; fall back to normal generation

    # --- MCP RAG path: strict metadata-driven generation ---
    if use_mcp_rag:
        try:
            from app.services.rag_service import RAGService

            retrieved_chunks = await RAGService.retrieve(
                db=db,
                project_id=UUID(project_id),
                query_text=prompt,
                top_k=8,
            )

            if retrieved_chunks:
                # --- Filter chunks to target object only ---
                # Extract object name from user prompt to filter out unrelated metadata
                import re as _re
                prompt_lower = prompt.lower()
                # Try to extract the object name from common prompt patterns
                obj_match = _re.search(
                    r'(?:create|new|edit|update|delete|view|test)\s+(?:a\s+)?(?:new\s+)?'
                    r'(\w[\w\s]*?)(?:\s+record|\s+for|\s+with|\s+-|\s*$)',
                    prompt_lower
                )
                target_obj = obj_match.group(1).strip() if obj_match else None

                if target_obj:
                    # Filter chunks that mention the target object
                    filtered = [c for c in retrieved_chunks if target_obj in c.lower()]
                    if filtered:
                        print(f"[TEST-GEN] Filtered {len(retrieved_chunks)} chunks → {len(filtered)} chunks for object '{target_obj}'")
                        retrieved_chunks = filtered
                    else:
                        print(f"[TEST-GEN] No chunks matched '{target_obj}', using all {len(retrieved_chunks)} chunks")

                rag_context = await RAGService.build_rag_context(retrieved_chunks)
                test_case = await AIService.generate_test_case_with_mcp_rag(
                    prompt, rag_context, provider=provider, model=model
                )
                print(f"[TEST-GEN] MCP RAG generation successful with {len(retrieved_chunks)} chunks")
                return test_case
            else:
                print(f"[TEST-GEN] No RAG chunks found, falling back to standard with MCP instruction")
                session_instruction = (
                    "\n\nIMPORTANT: This is a Salesforce MCP-connected project. "
                    "DO NOT generate any login/authentication steps. "
                    "Use Salesforce Lightning URL patterns like /lightning/o/ObjectName/list."
                )
        except Exception as rag_err:
            print(f"[TEST-GEN] MCP RAG failed, falling back to standard: {rag_err}")

    # --- Standard path ---
    effective_prompt = prompt + session_instruction

    try:
        test_case = await AIService.generate_test_case(effective_prompt, provider=provider, model=model)
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
