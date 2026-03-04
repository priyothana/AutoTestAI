from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import List
from uuid import UUID
import asyncio
import logging

from app.db.session import get_db
from app.models.test_run import TestRun
from app.models.test_case import TestCase
from app.models.project import Project
from app.models.project_integration import ProjectIntegration
from app.schemas.test_run import TestRunCreate, TestRunResponse
from app.services.playwright_service import PlaywrightService
from app.services.session_service import SessionService
from app.models.app_settings import AppSettings

logger = logging.getLogger(__name__)
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

    # Resolve base_url: project.base_url → integration.instance_url → integration.base_url
    base_url = project.base_url if project else None
    if not base_url:
        int_result = await db.execute(
            select(ProjectIntegration).where(ProjectIntegration.project_id == test_case.project_id)
        )
        integration = int_result.scalars().first()
        if integration:
            base_url = integration.instance_url or integration.base_url

    # For Salesforce connected projects, instance_url can serve as base_url
    if not base_url:
        # Check if a connected integration has instance_url we can use later
        has_sf_instance = False
        if not base_url:
            check_int_result = await db.execute(
                select(ProjectIntegration).where(ProjectIntegration.project_id == test_case.project_id)
            )
            check_int = check_int_result.scalars().first()
            if check_int and check_int.status == "connected" and check_int.instance_url:
                base_url = check_int.instance_url
                has_sf_instance = True

        if not base_url:
            raise HTTPException(
                status_code=400,
                detail="Project base URL is missing. Please configure it in Project Settings or connect an integration."
            )

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

    # Resolve project category and integration status
    project_category = project.category if project else "webapp"
    integration_status = "disconnected"
    sf_access_token = None
    sf_instance_url = None
    sf_username = None
    sf_password = None
    sf_login_url = None
    try:
        int_result_for_status = await db.execute(
            select(ProjectIntegration).where(ProjectIntegration.project_id == test_case.project_id)
        )
        int_record = int_result_for_status.scalars().first()
        print(f"[DEBUG] int_record found: {bool(int_record)}")
        if int_record:
            integration_status = int_record.status or "disconnected"
            print(f"[DEBUG] integration status={integration_status}, category={int_record.category}")
            # Use integration category as effective category (project.category may still be 'webapp')
            if int_record.category == "salesforce":
                project_category = "salesforce"
            if int_record.access_token:
                sf_access_token = int_record.access_token
            if int_record.instance_url:
                sf_instance_url = int_record.instance_url
                # For connected SF, use instance_url as base_url (not login.salesforce.com)
                if integration_status == "connected" and int_record.category == "salesforce":
                    base_url = int_record.instance_url

            print(f"[DEBUG] project_category={project_category}, has_token={bool(sf_access_token)}, instance={sf_instance_url}")

            # --- Extract SF login credentials (decrypted) ---
            if project_category == "salesforce" and integration_status == "connected":
                from app.services.integration_service import IntegrationService
                decrypted = await IntegrationService.get_decrypted_tokens(int_record)
                if decrypted.get("username"):
                    sf_username = decrypted["username"]
                if decrypted.get("password"):
                    sf_password = decrypted["password"]
                sf_login_url = int_record.salesforce_login_url
                print(f"[DEBUG] SF creds: username={bool(sf_username)}, password={bool(sf_password)}, login_url={sf_login_url}")

            # --- Refresh expired Salesforce access token ---
            if (
                project_category == "salesforce"
                and integration_status == "connected"
                and int_record.refresh_token
                and int_record.client_id
                and int_record.client_secret
            ):
                from datetime import datetime as dt_cls
                from datetime import timezone, timedelta
                import httpx

                print(f"[SF-TOKEN] Checking token expiry: {int_record.token_expiry}")
                needs_refresh = True
                if int_record.token_expiry:
                    now = dt_cls.now(timezone.utc)
                    expiry = int_record.token_expiry if int_record.token_expiry.tzinfo else int_record.token_expiry.replace(tzinfo=timezone.utc)
                    if expiry > now:
                        needs_refresh = False
                        print(f"[SF-TOKEN] Token still valid until {expiry}")

                if needs_refresh:
                    print(f"[SF-TOKEN] Refreshing expired access token for project {test_case.project_id}")
                    login_url = int_record.salesforce_login_url or "https://login.salesforce.com"
                    token_url = f"{login_url}/services/oauth2/token"
                    print(f"[SF-TOKEN] Using login URL: {login_url} → token endpoint: {token_url}")
                    import asyncio as _asyncio
                    max_retries = 3
                    for attempt in range(1, max_retries + 1):
                        try:
                            async with httpx.AsyncClient(timeout=30.0) as client:
                                resp = await client.post(token_url, data={
                                    "grant_type": "refresh_token",
                                    "refresh_token": int_record.refresh_token,
                                    "client_id": int_record.client_id,
                                    "client_secret": int_record.client_secret,
                                })
                                if resp.status_code == 200:
                                    token_data = resp.json()
                                    new_token = token_data.get("access_token")
                                    new_instance = token_data.get("instance_url")
                                    if new_token:
                                        sf_access_token = new_token
                                        int_record.access_token = new_token
                                        if new_instance:
                                            sf_instance_url = new_instance
                                            int_record.instance_url = new_instance
                                            base_url = new_instance
                                        int_record.token_expiry = dt_cls.now(timezone.utc) + timedelta(hours=2)
                                        await db.commit()
                                        print(f"[SF-TOKEN] Token refreshed successfully on attempt {attempt}. Instance: {new_instance}")
                                    break  # success
                                else:
                                    print(f"[SF-TOKEN] Attempt {attempt}/{max_retries} FAILED: {resp.status_code} {resp.text}")
                                    if attempt < max_retries:
                                        await _asyncio.sleep(2 * attempt)  # backoff: 2s, 4s
                        except Exception as e:
                            print(f"[SF-TOKEN] Attempt {attempt}/{max_retries} error: {e}")
                            if attempt < max_retries:
                                await _asyncio.sleep(2 * attempt)
    except Exception as e:
        import traceback
        print(f"[ERROR] Session resolution failed: {e}")
        traceback.print_exc()

    print(f"[RUN] category={project_category} status={integration_status} base_url={base_url} has_token={bool(sf_access_token)} instance={sf_instance_url}")

    # 4. Trigger Background Execution
    background_tasks.add_task(
        run_playwright_test,
        str(new_run.id),
        base_url,
        test_case.steps,
        str(test_case.project_id),
        use_session,
        is_login_test,
        project_category,
        integration_status,
        sf_access_token,
        sf_instance_url,
        sf_username,
        sf_password,
        sf_login_url,
    )

    return new_run

async def run_playwright_test(
    run_id: str,
    base_url: str,
    steps: list,
    project_id: str = None,
    use_session_reuse: bool = True,
    is_login_test: bool = False,
    project_category: str = "webapp",
    integration_status: str = "disconnected",
    sf_access_token: str = None,
    sf_instance_url: str = None,
    sf_username: str = None,
    sf_password: str = None,
    sf_login_url: str = None,
):
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
        result_data = await PlaywrightService.execute_test_case(
            run_id, base_url, steps, project_id,
            use_session_reuse, is_login_test,
            project_category, integration_status,
            sf_access_token, sf_instance_url,
            sf_username, sf_password, sf_login_url,
        )
    except Exception as e:
        logger.error(f"CRITICAL ERROR in run_playwright_test wrapper for {run_id}: {e}", exc_info=True)
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

                    # Update TestCase status
                    final_status = result_data.get("status", "error")
                    test_case_status = "passed" if final_status == "passed" else "failed"
                    await session.execute(
                        update(TestCase)
                        .where(TestCase.id == test_run.test_case_id)
                        .values(status=test_case_status)
                    )

                    # If session was saved by PlaywrightService, update DB
                    if result_data.get("session_saved") and project_id:
                        source = "oauth" if integration_status == "connected" else "login_test"
                        await SessionService.save_session(session, UUID(project_id), source=source)

                    await session.commit()
                    logger.info(f"DB UPDATED for run {run_id}: status={final_status}, screenshot={test_run.screenshot_path}")
                else:
                    logger.error(f"Could not find test run {run_id} in DB for background update")
        except Exception as db_err:
            logger.error(f"FAILED to update database for test run {run_id}: {db_err}", exc_info=True)

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
