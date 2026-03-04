"""
Playwright Test Runner Service

Executes test steps in a headless Chromium browser.
Supports session management for Salesforce projects:
  - Loads stored sessions (storageState.json)
  - Silent login via frontdoor.jsp for connected projects
  - Validates sessions before non-login tests
  - Saves sessions after successful login tests
  - Auto-refreshes expired sessions
"""
from playwright.async_api import async_playwright
from datetime import datetime
import json
import os
import logging

logger = logging.getLogger(__name__)

# Session directory
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SESSIONS_DIR = os.path.join(_BACKEND_DIR, "sessions")
os.makedirs(SESSIONS_DIR, exist_ok=True)


class PlaywrightService:
    @staticmethod
    async def execute_test_case(
        test_run_id: str,
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
        """
        Execute a list of test steps in a headless browser.

        For Salesforce projects:
        - Connected: silent login via frontdoor.jsp if no session
        - Not connected: login test creates session
        - Validates sessions before non-login tests
        """
        print(f"[PW] STARTING RUN for testCase {test_run_id} | category={project_category} | status={integration_status}")
        logs = []
        overall_result = "passed"
        start_time = datetime.utcnow()
        session_saved = False
        session_expired = False

        async def run_logic():
            nonlocal overall_result, session_saved, session_expired
            async with async_playwright() as p:
                print("[PW] Launching Playwright...")
                browser = await p.chromium.launch(headless=True)

                # --- Session Path ---
                session_path = None
                if project_id and use_session_reuse:
                    session_path = os.path.join(SESSIONS_DIR, f"{project_id}.json")

                session_exists = session_path and os.path.exists(session_path)
                _is_login_test = is_login_test

                context = None
                page = None

                # ═══════════════════════════════════════════════════
                # CASE 1: Connected SF project, no session → browser login with credentials
                # ═══════════════════════════════════════════════════
                if (
                    project_category == "salesforce"
                    and integration_status == "connected"
                    and sf_username
                    and sf_password
                    and not session_exists
                ):
                    login_target = sf_login_url or "https://login.salesforce.com"
                    print(f"[SESSION] Connected SF: browser login for {project_id} via {login_target}")
                    context = await browser.new_context()
                    await context.tracing.start(screenshots=True, snapshots=True, sources=True)
                    page = await context.new_page()
                    try:
                        await page.goto(login_target, wait_until="networkidle", timeout=30000)
                        print(f"[SESSION] On login page: {page.url}")
                        # Fill Salesforce login form
                        await page.fill('#username', sf_username)
                        await page.fill('#password', sf_password)
                        await page.click('#Login')
                        print("[SESSION] Clicked Login, waiting for redirect away from login page...")
                        
                        # Wait for URL to change away from the login domain
                        import asyncio as _aio
                        login_domain = login_target.replace("https://", "").replace("http://", "").rstrip("/")
                        try:
                            # Wait up to 60s for URL to leave the login domain
                            await page.wait_for_url(
                                lambda url: login_domain not in url,
                                timeout=60000
                            )
                            await page.wait_for_load_state('networkidle', timeout=30000)
                            await _aio.sleep(2)
                        except Exception:
                            pass  # timeout — will check URL below
                        
                        current_url = page.url
                        print(f"[SESSION] After login, current URL = {current_url}")
                        
                        # Login succeeded if URL moved away from login domain
                        still_on_login = login_domain in current_url.lower()
                        if still_on_login:
                            print(f"[SESSION] Browser login FAILED — still on login domain: {login_domain}")
                            # Check if there's an error message on the page
                            try:
                                error_el = page.locator('#error')
                                if await error_el.count() > 0:
                                    error_text = await error_el.text_content()
                                    print(f"[SESSION] Login error message: {error_text}")
                            except Exception:
                                pass
                        else:
                            if session_path:
                                await context.storage_state(path=session_path)
                                session_saved = True
                                print(f"[SESSION] Browser login succeeded, session saved for {project_id}")
                    except Exception as e:
                        print(f"[SESSION] Browser login error: {e}")
                # ═══════════════════════════════════════════════════
                # CASE 2: Session exists → load it
                # ═══════════════════════════════════════════════════
                elif session_exists and not _is_login_test:
                    print(f"[SESSION] Loading existing session for {project_id}")
                    try:
                        context = await browser.new_context(storage_state=session_path)
                    except Exception as e:
                        print(f"[SESSION] Failed to load session: {e}")
                        context = await browser.new_context()
                    await context.tracing.start(screenshots=True, snapshots=True, sources=True)
                    page = await context.new_page()
                # ═══════════════════════════════════════════════════
                # CASE 3: No session, not connected → normal (login test)
                # ═══════════════════════════════════════════════════
                else:
                    if session_path and not session_exists:
                        _is_login_test = True
                        print(f"[SESSION] No session for {project_id}, marking as login test")
                    context = await browser.new_context()
                    await context.tracing.start(screenshots=True, snapshots=True, sources=True)
                    page = await context.new_page()

                # Screenshot directory
                screenshot_base_dir = "static/test-runs"
                run_screenshot_dir = os.path.join(screenshot_base_dir, test_run_id)
                os.makedirs(run_screenshot_dir, exist_ok=True)
                final_screenshot_path = None

                # ═══════════════════════════════════════════════════
                # Session Validation for Salesforce (when loaded from file)
                # ═══════════════════════════════════════════════════
                if (
                    project_category == "salesforce"
                    and session_exists
                    and not _is_login_test
                    and not session_saved  # skip if we just did frontdoor login
                ):
                    try:
                        logger.info(f"[SESSION] Validating SF session for {project_id}")
                        await page.goto(
                            base_url + "/lightning/page/home",
                            wait_until="networkidle",
                            timeout=30000,
                        )
                        current_url = page.url.lower()
                        if "/login" in current_url or "/authorize" in current_url:
                            logger.warning(f"[SESSION] Session expired for {project_id}")
                            session_expired = True
                            if session_path and os.path.exists(session_path):
                                os.remove(session_path)

                            await context.tracing.stop()
                            await browser.close()
                            browser = await p.chromium.launch(headless=True)

                            # Try silent re-login if connected
                            if integration_status == "connected" and sf_access_token and sf_instance_url:
                                logger.info("[SESSION] Re-login via frontdoor.jsp")
                                context = await browser.new_context()
                                await context.tracing.start(screenshots=True, snapshots=True, sources=True)
                                page = await context.new_page()
                                frontdoor_url = f"{sf_instance_url}/secur/frontdoor.jsp?sid={sf_access_token}"
                                try:
                                    await page.goto(frontdoor_url, wait_until="networkidle", timeout=30000)
                                    if "/login" not in page.url.lower():
                                        if session_path:
                                            await context.storage_state(path=session_path)
                                            session_saved = True
                                            logger.info("[SESSION] Re-login succeeded, session refreshed")
                                except Exception as re_err:
                                    logger.error(f"[SESSION] Re-login failed: {re_err}")
                            else:
                                context = await browser.new_context()
                                await context.tracing.start(screenshots=True, snapshots=True, sources=True)
                                page = await context.new_page()
                        else:
                            logger.info(f"[SESSION] Session valid for {project_id}")
                    except Exception as e:
                        logger.warning(f"[SESSION] Validation error: {e}, proceeding")

                # ═══════════════════════════════════════════════════
                # Execute Test Steps
                # ═══════════════════════════════════════════════════
                try:
                    for index, step in enumerate(steps):
                        step_start = datetime.utcnow()
                        if hasattr(step, "action"):
                            action = step.action.lower().strip()
                            target = step.target
                            value = step.value
                        else:
                            action = step.get("action", "").lower().strip()
                            target = step.get("target", "")
                            value = step.get("value", "")

                        logger.info(f"Executing step {index+1}: {action} on {target}")
                        step_order = index + 1
                        step_log = {
                            "step_order": step_order,
                            "action": action,
                            "target": target,
                            "value": value,
                            "status": "running",
                            "started_at": step_start.isoformat(),
                        }

                        try:
                            if action in ["navigate", "goto"]:
                                full_target = (
                                    base_url + (target if target.startswith("/") else "/" + target)
                                    if target
                                    else base_url
                                )
                                await page.goto(full_target, wait_until="networkidle", timeout=45000)

                            elif action == "click":
                                locator = page.locator(target)
                                await locator.wait_for(state="visible", timeout=15000)
                                await locator.click(timeout=15000)

                            elif action in ["fill", "input", "type"]:
                                locator = page.locator(target)
                                await locator.wait_for(state="visible", timeout=15000)
                                await locator.fill(value or "", timeout=15000)

                            elif action == "assert_text":
                                locator = page.locator(target)
                                await locator.wait_for(state="visible", timeout=15000)
                                text_content = await locator.text_content()
                                if value not in (text_content or ""):
                                    raise Exception(
                                        f"Assertion failed: expected '{value}' in '{text_content}'"
                                    )

                            elif action == "wait":
                                wait_time = int(value) if value else 1000
                                await page.wait_for_timeout(wait_time)

                            else:
                                step_log["note"] = f"Unsupported action: {action}"

                            step_log["status"] = "success"
                            logger.info(f"  ✅ STEP {step_order} SUCCESS: {action}")

                        except Exception as e:
                            logger.info(f"  ❌ STEP {step_order} FAILED: {action} - {e}")
                            step_log["status"] = "failed"
                            step_log["error"] = str(e)
                            overall_result = "failed"

                            filename = "error.png"
                            save_path = os.path.join(run_screenshot_dir, filename)
                            await page.screenshot(path=save_path, full_page=True)
                            final_screenshot_path = f"/static/test-runs/{test_run_id}/{filename}"
                            step_log["screenshot_url"] = final_screenshot_path

                            step_log["ended_at"] = datetime.utcnow().isoformat()
                            step_log["duration_ms"] = (
                                datetime.utcnow() - step_start
                            ).total_seconds() * 1000
                            logs.append(step_log)
                            break

                        step_log["ended_at"] = datetime.utcnow().isoformat()
                        step_log["duration_ms"] = (
                            datetime.utcnow() - step_start
                        ).total_seconds() * 1000
                        logs.append(step_log)

                    # Final screenshot on success
                    if overall_result == "passed":
                        filename = "final.png"
                        save_path = os.path.join(run_screenshot_dir, filename)
                        await page.screenshot(path=save_path, full_page=True)
                        final_screenshot_path = f"/static/test-runs/{test_run_id}/{filename}"

                        # Save session after successful login test
                        if _is_login_test and session_path and not session_saved:
                            try:
                                if "lightning" in page.url:
                                    await page.wait_for_url("**/lightning/**", timeout=5000)
                                else:
                                    await page.wait_for_load_state("networkidle", timeout=5000)
                            except Exception:
                                pass
                            await context.storage_state(path=session_path)
                            session_saved = True
                            logger.info(f"[SESSION] Saved session after login test for {project_id}")

                except Exception as e:
                    logger.error(f"Execution failed: {e}")
                    overall_result = "error"
                    logs.append({
                        "step_order": 0,
                        "action": "SYSTEM",
                        "error": str(e),
                        "status": "error",
                        "started_at": datetime.utcnow().isoformat(),
                    })
                finally:
                    trace_path = os.path.join(run_screenshot_dir, "trace.zip")
                    await context.tracing.stop(path=trace_path)
                    await browser.close()

                return final_screenshot_path

        try:
            import asyncio
            final_path = await asyncio.wait_for(run_logic(), timeout=600)
        except asyncio.TimeoutError:
            logger.error(f"Run {test_run_id} TIMED OUT after 10 minutes")
            overall_result = "timeout"
            final_path = None
            logs.append({
                "step_order": 999,
                "action": "SYSTEM",
                "error": "Global timeout exceeded (10 minutes)",
                "status": "timeout",
                "started_at": datetime.utcnow().isoformat(),
            })
        except Exception as e:
            logger.error(f"Unexpected error in execute_test_case: {e}")
            overall_result = "error"
            final_path = None
            if not logs:
                logs.append({
                    "step_order": 0,
                    "action": "SYSTEM",
                    "error": str(e),
                    "status": "error",
                    "started_at": datetime.utcnow().isoformat(),
                })

        duration = (datetime.utcnow() - start_time).total_seconds()
        logger.info(f"Run finished. Result: {overall_result}, Duration: {duration}s")

        return {
            "status": overall_result,
            "logs": logs,
            "duration": duration,
            "screenshot_path": final_path,
            "completed_at": datetime.utcnow(),
            "session_saved": session_saved,
            "session_expired": session_expired,
        }
