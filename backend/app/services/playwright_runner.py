import os
from typing import List, Dict, Any
from datetime import datetime
from playwright.sync_api import sync_playwright, Page, expect

# Define supported actions
class ActionType:
    NAVIGATE = "NAVIGATE"
    CLICK = "CLICK"
    TYPE = "TYPE"
    ASSERT_TEXT = "ASSERT_TEXT"
    WAIT = "WAIT"

class PlaywrightRunner:
    def __init__(self, headless: bool = True, project_id: str = None, use_session_reuse: bool = True, is_login_test: bool = False):
        self.headless = headless
        self.project_id = project_id
        self.use_session_reuse = use_session_reuse
        self.is_login_test = is_login_test
        self.artifacts_dir = "artifacts"
        
        # Determine base directory to securely use backend/sessions
        # Using __file__ allows this to resolve correctly even inside Docker mounts
        current_dir = os.path.dirname(os.path.abspath(__file__)) # .../app/services
        backend_dir = os.path.dirname(os.path.dirname(current_dir)) # .../backend
        self.sessions_dir = os.path.join(backend_dir, "sessions")
            
        os.makedirs(self.artifacts_dir, exist_ok=True)
        os.makedirs(self.sessions_dir, exist_ok=True)

    def execute_steps(self, steps: List[Dict[str, Any]], execution_id: str) -> Dict[str, Any]:
        logs = []
        status = "PASSED"
        error_message = None
        video_path = None
        
        # Create execution specific artifact dir
        run_dir = os.path.join(self.artifacts_dir, str(execution_id))
        os.makedirs(run_dir, exist_ok=True)

        session_path = None
        if self.project_id and self.use_session_reuse:
            session_path = os.path.join(self.sessions_dir, f"{self.project_id}.json")

        session_exists = session_path and os.path.exists(session_path)

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=self.headless)
            
            context_args = {"record_video_dir": run_dir}
            
            session_loaded = False
            # Load session state if it exists, use_session_reuse is true, and it's NOT a login test
            if session_exists and not self.is_login_test:
                try:
                    context_args["storage_state"] = session_path
                    session_loaded = True
                    logs.append(f"[{datetime.now()}] [SESSION] Loaded session for project {self.project_id}")
                    print(f"[SESSION] Loaded session for project {self.project_id}")
                except Exception as e:
                    logs.append(f"[{datetime.now()}] Warning: Failed to load session from {session_path}. Error: {e}")
                    # If loading fails, we proceed without session cache by removing it from context_args
                    if "storage_state" in context_args:
                        del context_args["storage_state"]
            elif session_path and not session_exists:
                logs.append(f"[{datetime.now()}] [SESSION] No session found for project {self.project_id}")
                print(f"[SESSION] No session found for project {self.project_id}")
                # Force Mode A: If first test (no session), treat it as a Login test
                self.is_login_test = True
            
            context = browser.new_context(**context_args)
            page = context.new_page()
            
            logs.append(f"[{datetime.now()}] Browser launched (Chromium)")

            try:
                for i, step in enumerate(steps):
                    action = step.get("action")
                    target = step.get("target")
                    value = step.get("value")
                    
                    logs.append(f"[{datetime.now()}] Step {i+1}: {action} {target} {value or ''}")
                    
                    self._execute_single_step(page, action, target, value)
                    
                    # Detect redirect to login if session was loaded (Session Expiry Detection)
                    if session_loaded and action == ActionType.NAVIGATE:
                        # Wait a bit for potential redirects
                        page.wait_for_timeout(1000)
                        if "login" in page.url.lower():
                            raise Exception("SESSION_EXPIRED")
                    
                # After all steps completed successfully, save session if this is a login test
                if status == "PASSED" and self.is_login_test and session_path:
                    try:
                        # Wait for dashboard UI or URL change
                        if "lightning" in page.url:
                            page.wait_for_url("**/lightning/**", timeout=5000)
                        else:
                            page.wait_for_load_state("networkidle", timeout=5000)
                    except Exception:
                        pass # Ignore if it times out, save state anyway
                        
                    context.storage_state(path=session_path)
                    logs.append(f"[{datetime.now()}] [SESSION] Saved session for project {self.project_id}")
                    print(f"[SESSION] Saved session for project {self.project_id}")
                    
            except Exception as e:
                status = "FAILED"
                error_message = str(e)
                logs.append(f"[{datetime.now()}] ERROR: {error_message}")
                # Capture failure screenshot
                screenshot_path = os.path.join(run_dir, "failure.png")
                page.screenshot(path=screenshot_path)
                logs.append(f"[{datetime.now()}] Screenshot saved to {screenshot_path}")
            
            finally:
                context.close()
                browser.close()
                
                # Find video file
                if os.path.exists(run_dir):
                    files = os.listdir(run_dir)
                    for f in files:
                        if f.endswith(".webm"):
                            video_path = os.path.join(run_dir, f)
                            break

        return {
            "status": status,
            "logs": "\n".join(logs),
            "video_path": video_path,
            "error": error_message
        }

    def _execute_single_step(self, page: Page, action: str, target: str, value: str):
        if action == ActionType.NAVIGATE:
            page.goto(value)
        
        elif action == ActionType.CLICK:
            page.click(target)
            
        elif action == ActionType.TYPE:
            page.fill(target, value)
            
        elif action == ActionType.ASSERT_TEXT:
            # Using expect for auto-retrying assertion
            expect(page.locator(target)).to_contain_text(value)
            
        elif action == ActionType.WAIT:
            try:
                time_ms = int(value)
                page.wait_for_timeout(time_ms)
            except ValueError:
                pass
        
        else:
            raise ValueError(f"Unsupported action: {action}")
