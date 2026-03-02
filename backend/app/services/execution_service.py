import asyncio
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from app.models.execution import Execution
from app.models.test_case import TestCase
from app.db.session import AsyncSessionLocal
import uuid
from datetime import datetime

class ExecutionService:
    @staticmethod
    async def run_test_background(execution_id: uuid.UUID):
        async with AsyncSessionLocal() as db:
            print(f"Starting execution {execution_id}")
            
            # Fetch execution
            result = await db.execute(select(Execution).where(Execution.id == execution_id))
            execution = result.scalars().first()
            if not execution:
                return

            execution.status = "RUNNING"
            execution.logs = "Starting execution environment...\nBrowser launched."
            await db.commit()
            
            # Fetch Test Case (Assuming we have implemented fetching test steps)
            # For now, using execution's test_case relationship if available, or fetch manually
            stmt = select(TestCase).where(TestCase.id == execution.test_case_id)
            result = await db.execute(stmt)
            test_case = result.scalars().first()
            
            if not test_case:
                execution.logs = "Error: Test Case not found."
                execution.status = "FAILED"
                await db.commit()
                return

            # Convert steps model to dict for runner
            steps_data = [step if isinstance(step, dict) else step.dict() for step in test_case.steps]
            
            # Fetch AppSettings for use_session_reuse
            from app.models.app_settings import AppSettings
            settings_stmt = select(AppSettings).limit(1)
            settings_result = await db.execute(settings_stmt)
            app_settings = settings_result.scalars().first()
            use_session_reuse = getattr(app_settings, "use_session_reuse", True) if app_settings else True
            
            # Detect if test case is a login test
            is_login_test = False
            tc_name = (test_case.name or "").lower()
            if "login" in tc_name:
                is_login_test = True
            else:
                for step in steps_data:
                    action = str(step.get("action", "")).lower()
                    target = str(step.get("target", "")).lower()
                    if action == "type" and ("email" in target or "username" in target or "password" in target):
                        is_login_test = True
                        break
            
            # Execute with Playwright Runner
            # Run in a separate thread to not block async loop
            from app.services.playwright_runner import PlaywrightRunner
            
            runner = PlaywrightRunner(
                headless=True,
                project_id=str(test_case.project_id) if test_case.project_id else None,
                use_session_reuse=use_session_reuse,
                is_login_test=is_login_test
            )
            
            # Run synchronous Playwright code in thread pool
            result_data = await asyncio.to_thread(
                runner.execute_steps, 
                steps_data, 
                str(execution.id)
            )
            
            # --- Automatic Session Recovery ---
            if result_data.get("error") == "SESSION_EXPIRED":
                result_data["logs"] += "\n[SESSION] Session expired (redirected to login). Automatically rerunning login steps..."
                
                # Fetch login test for this project
                login_tc = None
                all_tcs_stmt = select(TestCase).where(TestCase.project_id == test_case.project_id)
                all_tcs_result = await db.execute(all_tcs_stmt)
                for tc in all_tcs_result.scalars():
                    tc_n = (tc.name or "").lower()
                    if "login" in tc_n:
                        login_tc = tc
                        break
                    tc_steps = [step if isinstance(step, dict) else step.dict() for step in tc.steps]
                    for step in tc_steps:
                        action = str(step.get("action", "")).lower()
                        target = str(step.get("target", "")).lower()
                        if action == "type" and ("email" in target or "username" in target or "password" in target):
                            login_tc = tc
                            break
                    if login_tc:
                        break
                        
                if login_tc:
                    login_steps_data = [step if isinstance(step, dict) else step.dict() for step in login_tc.steps]
                    
                    login_runner = PlaywrightRunner(
                        headless=True,
                        project_id=str(test_case.project_id) if test_case.project_id else None,
                        use_session_reuse=use_session_reuse,
                        is_login_test=True
                    )
                    
                    login_result = await asyncio.to_thread(
                        login_runner.execute_steps,
                        login_steps_data,
                        f"{execution.id}_login_retry"
                    )
                    
                    if login_result["status"] == "PASSED":
                        result_data["logs"] += "\n[SESSION] Login steps rerun successfully. Retrying original test..."
                        # Retry original test
                        result_data = await asyncio.to_thread(
                            runner.execute_steps, 
                            steps_data, 
                            str(execution.id)
                        )
                    else:
                        result_data["logs"] += f"\n[SESSION] Failed to rerun login steps. Log: {login_result.get('logs')}"
                        result_data["status"] = "FAILED"
                        result_data["error"] = "Session recovery failed."
                else:
                    result_data["logs"] += "\n[SESSION] No login test case found for this project to auto-recover."
                    result_data["status"] = "FAILED"
            # ----------------------------------
            
            # Update Result
            execution.status = result_data["status"]
            execution.logs = result_data["logs"]
            execution.completed_at = datetime.now()
            execution.result_metadata = {
                "browser": "Chromium",
                "video_path": result_data.get("video_path"),
                "error": result_data.get("error")
            }
            
            await db.commit()
            print(f"Execution {execution_id} completed with status {execution.status}")

    @staticmethod
    async def trigger_execution(test_id: uuid.UUID, db: AsyncSession) -> Execution:
        new_execution = Execution(
            test_case_id=test_id,
            status="PENDING"
        )
        db.add(new_execution)
        await db.commit()
        await db.refresh(new_execution)
        return new_execution
