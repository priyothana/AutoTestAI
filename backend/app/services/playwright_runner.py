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
                    locator_type = (step.get("locator_type") or "").lower().strip()
                    
                    logs.append(f"[{datetime.now()}] Step {i+1}: {action} {target} {value or ''} (locator_type={locator_type})")
                    
                    self._execute_single_step(page, action, target, value, locator_type)
                    
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
                            page.wait_for_load_state("load", timeout=5000)
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

    def _first_visible_sync(self, locator):
        """Find the first visible element from a multi-match locator (sync)."""
        count = locator.count()
        if count <= 1:
            return locator.first
        for i in range(count):
            el = locator.nth(i)
            try:
                if el.is_visible():
                    return el
            except Exception:
                continue
        return locator.first

    def _resolve_locator_sync(self, page: Page, target: str, locator_type: str):
        """Resolve a Playwright locator based on locator_type (sync version)."""
        import re

        # Auto-detect locator_type from target pattern when not explicitly set
        if not locator_type and target:
            if re.match(r"role=\w+,\s*name=", target):
                locator_type = "role"
            elif target.startswith("label="):
                locator_type = "label"
                target = target[6:]
            elif target.startswith("text="):
                locator_type = "text"
                target = target[5:]
            elif not re.search(r'[.#\[\]>:=]', target):
                locator_type = "label"

        if locator_type == "role":
            role_match = re.match(r"role=(\w+),\s*name=(.+)", target)
            if role_match:
                role = role_match.group(1).strip()
                name = role_match.group(2).strip()
                return self._first_visible_sync(page.get_by_role(role, name=name, exact=False))
            return page.locator(target)

        elif locator_type == "label":
            # Handle API names like "Designation__c" → try "Designation"
            import re as _re
            labels_to_try = [target]
            if "__c" in target or "__r" in target:
                clean = _re.sub(r'__c$|__r$', '', target).replace('_', ' ').strip()
                if clean != target:
                    labels_to_try.insert(0, clean)

            for label_target in labels_to_try:
                # Scope to Salesforce modal first
                modal_scopes = ["div.modal-body", "div.slds-modal__content", "records-record-edit-form", "section.slds-modal"]
                for scope_sel in modal_scopes:
                    try:
                        scope = page.locator(scope_sel)
                        if scope.count() > 0 and scope.first.is_visible():
                            scoped_label = scope.first.get_by_label(label_target, exact=True)
                            if scoped_label.count() > 0:
                                vis = self._first_visible_sync(scoped_label)
                                if vis.is_visible():
                                    return vis
                            scoped_textbox = scope.first.get_by_role("textbox", name=label_target, exact=False)
                            if scoped_textbox.count() > 0:
                                vis = self._first_visible_sync(scoped_textbox)
                                if vis.is_visible():
                                    return vis
                    except Exception:
                        continue

                try:
                    textbox_loc = page.get_by_role("textbox", name=label_target, exact=False)
                    if textbox_loc.count() > 0:
                        result = self._first_visible_sync(textbox_loc)
                        if result.is_visible():
                            return result
                except Exception:
                    pass

                try:
                    xpath_loc = page.locator(
                        f"xpath=//label[contains(.,'{label_target}')]/ancestor::*[contains(@class,'slds-form-element')][1]//input | "
                        f"//span[text()='{label_target}']/ancestor::*[contains(@class,'slds-form-element')][1]//input"
                    )
                    if xpath_loc.count() > 0:
                        vis = self._first_visible_sync(xpath_loc)
                        if vis.is_visible():
                            return vis
                except Exception:
                    pass

                try:
                    ph_loc = page.get_by_placeholder(label_target, exact=False)
                    if ph_loc.count() > 0:
                        result = self._first_visible_sync(ph_loc)
                        if result.is_visible():
                            return result
                except Exception:
                    pass

            return page.get_by_label(target, exact=True).first

        elif locator_type == "text":
            return self._first_visible_sync(page.get_by_text(target, exact=False))

        elif locator_type == "css":
            return page.locator(target).first

        else:
            # Backward compatibility: no locator_type, try CSS first
            try:
                loc = page.locator(target)
                if loc.count() > 0:
                    return loc.first
            except Exception:
                pass

            # Fallback: extract title and try role-based
            title_match = re.search(r"\[title=['\"](.+?)['\"]\]", target)
            if title_match:
                btn_name = title_match.group(1)
                for role in ["button", "link", "menuitem", "tab"]:
                    try:
                        role_loc = page.get_by_role(role, name=btn_name, exact=False)
                        if role_loc.count() > 0:
                            return role_loc.first
                    except Exception:
                        continue

            # Final fallback
            return page.locator(target).first

    def _execute_single_step(self, page: Page, action: str, target: str, value: str, locator_type: str = ""):
        if action == ActionType.NAVIGATE:
            page.goto(value)
            # Auto-wait for UI rendering after navigation
            try:
                page.wait_for_load_state("load", timeout=10000)
            except Exception:
                pass

        elif action == ActionType.CLICK:
            locator = self._resolve_locator_sync(page, target, locator_type)
            locator.wait_for(state="visible", timeout=15000)
            locator.click()

        elif action == ActionType.TYPE:
            locator = self._resolve_locator_sync(page, target, locator_type)
            locator.wait_for(state="visible", timeout=15000)
            locator.fill(value)

        elif action == ActionType.ASSERT_TEXT:
            locator = self._resolve_locator_sync(page, target, locator_type)
            expect(locator).to_contain_text(value)

        elif action == ActionType.WAIT:
            try:
                time_val = int(value)
                # AI generates seconds, Playwright needs ms
                if time_val < 100:
                    time_val = time_val * 1000
                page.wait_for_timeout(time_val)
            except ValueError:
                pass

        else:
            raise ValueError(f"Unsupported action: {action}")
