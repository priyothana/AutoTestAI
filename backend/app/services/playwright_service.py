from playwright.async_api import async_playwright
from datetime import datetime
import json
import os

class PlaywrightService:
    @staticmethod
    async def execute_test_case(test_run_id: str, base_url: str, steps: list, project_id: str = None, use_session_reuse: bool = True, is_login_test: bool = False):
        print(f"STARTING RUN for testCase {test_run_id}")
        logs = []
        overall_result = "passed"
        start_time = datetime.utcnow()
        
        async def run_logic():
            nonlocal overall_result
            async with async_playwright() as p:
                print("Launching Playwright...")
                browser = await p.chromium.launch(headless=True)
                
                # --- Session Management Injection ---
                current_dir = os.path.dirname(os.path.abspath(__file__))
                backend_dir = os.path.dirname(os.path.dirname(current_dir))
                sessions_dir = os.path.join(backend_dir, "sessions")
                os.makedirs(sessions_dir, exist_ok=True)
                
                session_path = None
                if project_id and use_session_reuse:
                    session_path = os.path.join(sessions_dir, f"{project_id}.json")
                    
                session_exists = session_path and os.path.exists(session_path)
                
                _is_login_test = is_login_test
                if session_path and not session_exists:
                    _is_login_test = True
                    print(f"[SESSION] No session found for project {project_id}")
                
                context_args = {}
                if session_exists and not _is_login_test:
                    try:
                        context_args["storage_state"] = session_path
                        print(f"[SESSION] Loaded session for project {project_id}")
                    except Exception as e:
                        print(f"[SESSION] Warning: Failed to load session from {session_path}. Error: {e}")
                # ------------------------------------
                
                context = await browser.new_context(**context_args)
                
                # Start tracing
                await context.tracing.start(screenshots=True, snapshots=True, sources=True)
                page = await context.new_page()
                
                # Define screenshot directory
                screenshot_base_dir = "static/test-runs"
                run_screenshot_dir = os.path.join(screenshot_base_dir, test_run_id)
                os.makedirs(run_screenshot_dir, exist_ok=True)
                
                final_screenshot_path = None

                try:
                    for index, step in enumerate(steps):
                        step_start = datetime.utcnow()
                        # steps can be objects or dicts depending on where they come from
                        if hasattr(step, "action"):
                            action = step.action.lower().strip()
                            target = step.target
                            value = step.value
                        else:
                            action = step.get("action", "").lower().strip()
                            target = step.get("target", "")
                            value = step.get("value", "")
                        
                        print(f"Executing step {index+1}: {action} on {target}")
                        step_order = index + 1
                        step_log = {
                            "step_order": step_order,
                            "action": action,
                            "target": target,
                            "value": value,
                            "status": "running",
                            "started_at": step_start.isoformat()
                        }
                        
                        try:
                            # Precise URL construction
                            if action in ["navigate", "goto"]:
                                full_target = base_url + (target if target.startswith("/") else "/" + target) if target else base_url
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
                                    raise Exception(f"Assertion failed: expected '{value}' in '{text_content}'")
                                    
                            elif action == "wait":
                                wait_time = int(value) if value else 1000
                                await page.wait_for_timeout(wait_time)
                                
                            else:
                                step_log["note"] = f"Unsupported action: {action}"
                                
                            step_log["status"] = "success"
                            print(f"  ✅ STEP {step_order} SUCCESS: {action}")
                            
                        except Exception as e:
                            print(f"  ❌ STEP {step_order} FAILED: {action} - {e}")
                            step_log["status"] = "failed"
                            step_log["error"] = str(e)
                            overall_result = "failed"
                            
                            # Screenshot on failure
                            filename = "error.png"
                            save_path = os.path.join(run_screenshot_dir, filename)
                            await page.screenshot(path=save_path, full_page=True)
                            final_screenshot_path = f"/static/test-runs/{test_run_id}/{filename}"
                            step_log["screenshot_url"] = final_screenshot_path
                            
                            step_log["ended_at"] = datetime.utcnow().isoformat()
                            step_log["duration_ms"] = (datetime.utcnow() - step_start).total_seconds() * 1000
                            logs.append(step_log)
                            break
                        
                        step_log["ended_at"] = datetime.utcnow().isoformat()
                        step_log["duration_ms"] = (datetime.utcnow() - step_start).total_seconds() * 1000
                        logs.append(step_log)

                    # Final screenshot on success
                    if overall_result == "passed":
                        filename = "final.png"
                        save_path = os.path.join(run_screenshot_dir, filename)
                        await page.screenshot(path=save_path, full_page=True)
                        final_screenshot_path = f"/static/test-runs/{test_run_id}/{filename}"
                        
                        # --- Session Write Injection ---
                        if _is_login_test and session_path:
                            try:
                                if "lightning" in page.url:
                                    await page.wait_for_url("**/lightning/**", timeout=5000)
                                else:
                                    await page.wait_for_load_state("networkidle", timeout=5000)
                            except Exception:
                                pass
                            await context.storage_state(path=session_path)
                            print(f"[SESSION] Saved session for project {project_id}")
                        # ------------------------------------

                except Exception as e:
                    print(f"Execution failed: {e}")
                    overall_result = "error"
                    logs.append({
                        "step_order": 0,
                        "action": "SYSTEM",
                        "error": str(e),
                        "status": "error",
                        "started_at": datetime.utcnow().isoformat()
                    })
                finally:
                    # Stop tracing and save trace file
                    trace_path = os.path.join(run_screenshot_dir, "trace.zip")
                    await context.tracing.stop(path=trace_path)
                    await browser.close()
                
                return final_screenshot_path

        try:
            # 10-minute global timeout
            import asyncio
            final_path = await asyncio.wait_for(run_logic(), timeout=600)
        except asyncio.TimeoutError:
            print(f"!!! Run {test_run_id} TIMED OUT after 10 minutes !!!")
            overall_result = "timeout"
            final_path = None
            logs.append({
                "step_order": 999,
                "action": "SYSTEM",
                "error": "Global timeout exceeded (10 minutes)",
                "status": "timeout",
                "started_at": datetime.utcnow().isoformat()
            })
        except Exception as e:
            print(f"Unexpected error in execute_test_case: {e}")
            overall_result = "error"
            final_path = None
            if not logs:
                logs.append({
                    "step_order": 0,
                    "action": "SYSTEM",
                    "error": str(e),
                    "status": "error",
                    "started_at": datetime.utcnow().isoformat()
                })

        duration = (datetime.utcnow() - start_time).total_seconds()
        print(f"Run finished. Result: {overall_result}, Duration: {duration}s")
        
        return {
            "status": overall_result,
            "logs": logs,
            "duration": duration,
            "screenshot_path": final_path,
            "completed_at": datetime.utcnow()
        }
