from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import List
from uuid import UUID
import asyncio

from app.db.session import get_db
from app.models.test_run import TestRun
from app.models.test_case import TestCase
from app.models.project import Project
from app.schemas.test_run import TestRunCreate, TestRunResponse
from app.services.playwright_service import PlaywrightService
from app.models.app_settings import AppSettings

router = APIRouter()

@router.post("/", response_model=TestRunResponse)
async def create_test_run(
    run_req: TestRunCreate, 
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db)
):
    # 1. Verify Test Case exists
    result = await db.execute(select(TestCase).where(TestCase.id == run_req.test_case_id))
    test_case = result.scalars().first()
    if not test_case:
        raise HTTPException(status_code=404, detail="Test case not found")

    # 2. Get Project for Base URL
    result = await db.execute(select(Project).where(Project.id == test_case.project_id))
    project = result.scalars().first()
    if not project or not project.base_url:
        raise HTTPException(status_code=400, detail="Project base URL is missing. Please configure it in Project Settings.")

    # 3. Check if test case has steps
    if not test_case.steps or len(test_case.steps) == 0:
        raise HTTPException(status_code=400, detail="Test case has no steps defined. Add at least one step before running.")

    # 3. Create Test Run record (pending status)
    new_run = TestRun(
        test_case_id=run_req.test_case_id,
        status="running",
        logs=[]
    )
    db.add(new_run)
    await db.commit()
    await db.refresh(new_run)

    # Determine AppSettings and use_session_reuse
    settings_stmt = await db.execute(select(AppSettings).limit(1))
    app_settings = settings_stmt.scalars().first()
    use_session = getattr(app_settings, "use_session_reuse", True) if app_settings else True

    # determine is_login_test natively
    tc_n = (test_case.name or "").lower()
    is_login_test = False
    if "login" in tc_n:
        is_login_test = True
    else:
        for step in test_case.steps:
            # Handle both dicts and ORM objects
            action = step.action.lower() if hasattr(step, "action") else str(step.get("action", "")).lower()
            target = step.target.lower() if hasattr(step, "target") else str(step.get("target", "")).lower()
            if action in ["type", "fill"] and ("email" in target or "username" in target or "password" in target):
                is_login_test = True
                break

    # 4. Trigger Background Execution
    background_tasks.add_task(
        run_playwright_test,
        str(new_run.id),
        project.base_url,
        test_case.steps,
        str(test_case.project_id),
        use_session,
        is_login_test
    )

    return new_run

async def run_playwright_test(run_id: str, base_url: str, steps: list, project_id: str = None, use_session_reuse: bool = True, is_login_test: bool = False):
    from app.db.session import AsyncSessionLocal
    from sqlalchemy import update
    import traceback
    
    result_data = {
        "status": "error",
        "logs": [{"step_order": 0, "action": "SYSTEM", "error": "Unknown error occurred during initialization", "status": "error"}],
        "duration": 0
    }
    try:
        # Actually perform the test
        result_data = await PlaywrightService.execute_test_case(run_id, base_url, steps, project_id, use_session_reuse, is_login_test)
    except Exception as e:
        print(f"CRITICAL ERROR in run_playwright_test wrapper for {run_id}: {e}")
        traceback.print_exc()
        result_data = {
            "status": "error",
            "logs": [{"step_order": 999, "action": "SYSTEM", "error": f"Background wrapper error: {str(e)}", "status": "error"}],
            "duration": 0
        }
    finally:
        # ALWAYS update the database status
        try:
            async with AsyncSessionLocal() as session:
                result = await session.execute(select(TestRun).where(TestRun.id == UUID(run_id)))
                test_run = result.scalars().first()
                
                if test_run:
                    # Update TestRun
                    test_run.status = result_data.get("status", "error")
                    test_run.result = result_data.get("status", "error")
                    test_run.logs = result_data.get("logs", [])
                    test_run.duration = result_data.get("duration", 0)
                    test_run.screenshot_path = result_data.get("screenshot_path")
                    session.add(test_run)
                    
                    # Update TestCase status to the latest result (only if test_run was updated)
                    final_status = result_data.get("status", "error")
                    test_case_status = "passed" if final_status == "passed" else "failed"
                    
                    await session.execute(
                        update(TestCase)
                        .where(TestCase.id == test_run.test_case_id)
                        .values(status=test_case_status)
                    )
                    
                    await session.commit()
                    print(f"--- DB UPDATED for run {run_id}: status={final_status}, screenshot={test_run.screenshot_path} ---")
                else:
                    print(f"!!! Could not find test run {run_id} in DB for background update !!!")
        except Exception as db_err:
            print(f"!!! FAILED to update database for test run {run_id}: {db_err} !!!")
            traceback.print_exc()

@router.get("/{id}", response_model=TestRunResponse)
async def get_test_run(id: UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TestRun).where(TestRun.id == id))
    test_run = result.scalars().first()
    if not test_run:
        raise HTTPException(status_code=404, detail="Test run not found")
    
    # Populate test_case_name for the response
    test_case_result = await db.execute(select(TestCase.name).where(TestCase.id == test_run.test_case_id))
    test_case_name = test_case_result.scalar_one_or_none()
    
    # Create a TestRunResponse object to include test_case_name
    return TestRunResponse(
        id=test_run.id,
        status=test_run.status,
        result=test_run.result,
        duration=test_run.duration,
        logs=test_run.logs,
        screenshot_path=test_run.screenshot_path,
        test_case_id=test_run.test_case_id,
        test_case_name=test_case_name,
        created_at=test_run.created_at
    )

@router.get("/", response_model=List[TestRunResponse])
async def list_test_runs(test_case_id: UUID = None, skip: int = 0, limit: int = 100, db: AsyncSession = Depends(get_db)):
    query = (
        select(TestRun, TestCase.name.label("test_case_name"))
        .join(TestCase, TestRun.test_case_id == TestCase.id)
        .offset(skip)
        .limit(limit)
        .order_by(TestRun.created_at.desc())
    )
    if test_case_id:
        query = query.where(TestRun.test_case_id == test_case_id)
        
    result = await db.execute(query)
    test_runs = []
    for row in result:
        run_obj = row[0]
        run_obj.test_case_name = row[1]
        test_runs.append(run_obj)
    return test_runs

@router.delete("/{id}")
async def delete_test_run(id: UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TestRun).where(TestRun.id == id))
    test_run = result.scalars().first()
    if not test_run:
        raise HTTPException(status_code=404, detail="Test run not found")
    
    await db.delete(test_run)
    await db.commit()
    return {"message": "Test run deleted successfully"}
