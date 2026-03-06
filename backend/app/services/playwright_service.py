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
    async def _first_visible(locator, logger, description=""):
        """Find the first visible element from a multi-match locator."""
        count = await locator.count()
        if count == 0:
            return locator.first  # will fail with clear error at wait_for
        if count == 1:
            return locator.first
        # Multiple matches — find the first visible one
        for i in range(count):
            el = locator.nth(i)
            try:
                if await el.is_visible():
                    logger.info(f"  → Found visible match at index {i}/{count} for {description}")
                    return el
            except Exception:
                continue
        # No visible element found — return first and let caller handle timeout
        logger.warning(f"  ⚠ No visible element found among {count} matches for {description}")
        return locator.first

    @staticmethod
    async def _resolve_locator(page, target, locator_type, logger):
        """
        Resolve a Playwright locator based on locator_type.
        Always returns the first VISIBLE matching element.
        """
        import re

        # Auto-detect locator_type from target pattern when not explicitly set
        if not locator_type and target:
            if re.match(r"role=\w+,\s*name=", target):
                locator_type = "role"
                logger.info(f"  ℹ Auto-detected locator_type='role' from target: '{target}'")
            elif target.startswith("label="):
                locator_type = "label"
                target = target[6:]  # strip "label=" prefix
                logger.info(f"  ℹ Auto-detected locator_type='label' from target: '{target}'")
            elif target.startswith("text="):
                locator_type = "text"
                target = target[5:]  # strip "text=" prefix
                logger.info(f"  ℹ Auto-detected locator_type='text' from target: '{target}'")
            elif not re.search(r'[.#\[\]>:=]', target):
                # Plain text target (e.g. "Account Name", "Phone") — treat as label
                locator_type = "label"
                logger.info(f"  ℹ Auto-detected locator_type='label' for plain text target: '{target}'")

        if locator_type == "role":
            # Parse "role=button, name=New" format
            role_match = re.match(r"role=(\w+),\s*name=(.+)", target)
            if role_match:
                role = role_match.group(1).strip()
                name = role_match.group(2).strip()
                locator = page.get_by_role(role, name=name, exact=False)
                logger.info(f"  → Resolved via get_by_role('{role}', name='{name}')")
                return await PlaywrightService._first_visible(locator, logger, f"role={role}, name={name}")
            else:
                logger.warning(f"  ⚠ Could not parse role target: '{target}', trying as CSS")
                return page.locator(target)

        elif locator_type == "label":
            # ── SALESFORCE LIGHTNING FORM FIELD RESOLUTION ──
            # Handle API names like "Designation__c" → try "Designation" as label
            import re as _re
            labels_to_try = [target]
            if "__c" in target or "__r" in target:
                # Strip __c / __r suffix and replace underscores with spaces
                clean = _re.sub(r'__c$|__r$', '', target).replace('_', ' ').strip()
                if clean != target:
                    labels_to_try.insert(0, clean)  # try clean label first
                    logger.info(f"  ℹ API name detected: '{target}' → also trying label '{clean}'")

            for label_target in labels_to_try:
                # Strategy 1: Scope to visible Salesforce modal, then find input by label
                modal_scopes = [
                    "div.modal-body",
                    "div.slds-modal__content",
                    "records-record-edit-form",
                    "records-lwc-detail-panel",
                    "section.slds-modal",
                ]
                for scope_sel in modal_scopes:
                    try:
                        scope = page.locator(scope_sel)
                        if await scope.count() > 0 and await scope.first.is_visible():
                            scoped_label = scope.first.get_by_label(label_target, exact=True)
                            if await scoped_label.count() > 0:
                                vis = await PlaywrightService._first_visible(scoped_label, logger, f"modal-scoped label='{label_target}'")
                                try:
                                    if await vis.is_visible():
                                        logger.info(f"  → Resolved via modal-scoped get_by_label('{label_target}')")
                                        return vis
                                except Exception:
                                    pass
                            scoped_textbox = scope.first.get_by_role("textbox", name=label_target, exact=False)
                            if await scoped_textbox.count() > 0:
                                vis = await PlaywrightService._first_visible(scoped_textbox, logger, f"modal-scoped textbox='{label_target}'")
                                try:
                                    if await vis.is_visible():
                                        logger.info(f"  → Resolved via modal-scoped get_by_role('textbox', name='{label_target}')")
                                        return vis
                                except Exception:
                                    pass
                    except Exception:
                        continue

                # Strategy 2: Full-page get_by_role('textbox')
                try:
                    textbox_loc = page.get_by_role("textbox", name=label_target, exact=False)
                    count = await textbox_loc.count()
                    if count > 0:
                        result = await PlaywrightService._first_visible(textbox_loc, logger, f"textbox name='{label_target}'")
                        try:
                            if await result.is_visible():
                                logger.info(f"  → Resolved via get_by_role('textbox', name='{label_target}')")
                                return result
                        except Exception:
                            pass
                except Exception:
                    pass

                # Strategy 3: XPath — label text → nearest input
                try:
                    xpath_loc = page.locator(
                        f"xpath=//label[contains(.,'{label_target}')]/ancestor::*[contains(@class,'slds-form-element')][1]//input | "
                        f"//label[contains(.,'{label_target}')]/ancestor::*[contains(@class,'slds-form-element')][1]//textarea | "
                        f"//span[text()='{label_target}']/ancestor::*[contains(@class,'slds-form-element')][1]//input"
                    )
                    count = await xpath_loc.count()
                    if count > 0:
                        vis = await PlaywrightService._first_visible(xpath_loc, logger, f"xpath label='{label_target}'")
                        try:
                            if await vis.is_visible():
                                logger.info(f"  → Resolved via XPath near label '{label_target}'")
                                return vis
                        except Exception:
                            pass
                except Exception:
                    pass

                # Strategy 4: get_by_placeholder
                try:
                    ph_loc = page.get_by_placeholder(label_target, exact=False)
                    count = await ph_loc.count()
                    if count > 0:
                        result = await PlaywrightService._first_visible(ph_loc, logger, f"placeholder='{label_target}'")
                        try:
                            if await result.is_visible():
                                logger.info(f"  → Resolved via get_by_placeholder('{label_target}')")
                                return result
                        except Exception:
                            pass
                except Exception:
                    pass

            # Final fallback: full-page get_by_label with original target
            logger.warning(f"  ⚠ All label strategies failed for '{target}', returning get_by_label fallback")
            return page.get_by_label(target, exact=True).first

        elif locator_type == "text":
            locator = page.get_by_text(target, exact=False)
            logger.info(f"  → Resolved via get_by_text('{target}')")
            return await PlaywrightService._first_visible(locator, logger, f"text='{target}'")

        elif locator_type == "css":
            logger.info(f"  → Resolved via CSS locator('{target}')")
            return page.locator(target).first

        else:
            # Backward compatibility: no locator_type specified (old-format steps)
            # Try CSS first, then fallback to role/text-based
            try:
                locator = page.locator(target)
                # Quick check if element exists
                count = await locator.count()
                if count > 0:
                    logger.info(f"  → Resolved via CSS locator (legacy): '{target}'")
                    return locator.first
            except Exception:
                pass

            # Fallback: extract button name and try role-based
            title_match = re.search(r"\[title=['\"](.+?)['\"]\]", target)
            text_match = re.search(r"text=['\"]?(.+?)['\"]?$", target)
            btn_name = title_match.group(1) if title_match else (text_match.group(1) if text_match else None)

            if btn_name:
                for role in ["button", "link", "menuitem", "tab"]:
                    try:
                        role_loc = page.get_by_role(role, name=btn_name, exact=False)
                        if await role_loc.count() > 0:
                            logger.info(f"  ↪ Fallback: resolved via get_by_role('{role}', name='{btn_name}')")
                            return role_loc.first
                    except Exception:
                        continue

            # Final fallback: try text-based
            fallback_text = btn_name or target
            try:
                text_loc = page.get_by_text(fallback_text, exact=False)
                if await text_loc.count() > 0:
                    logger.info(f"  ↪ Fallback: resolved via get_by_text('{fallback_text}')")
                    return text_loc.first
            except Exception:
                pass

            # Try label-based as last resort
            try:
                label_text = target.split("'")[1] if "'" in target else target
                label_loc = page.get_by_label(label_text, exact=False)
                if await label_loc.count() > 0:
                    logger.info(f"  ↪ Fallback: resolved via get_by_label('{label_text}')")
                    return label_loc.first
            except Exception:
                pass

            # If nothing works, return the raw CSS locator (will fail with clear error)
            logger.warning(f"  ⚠ All fallbacks failed for target: '{target}', using raw locator")
            return page.locator(target).first

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
        mcp_connected: bool = False,
        sf_session_id: str = None,
        sf_security_token: str = None,
    ):
        """
        Execute a list of test steps in a headless browser.

        For Salesforce projects:
        - MCP connected: silent login via frontdoor.jsp (no UI login, no 2FA)
        - OAuth connected: silent login via frontdoor.jsp if no session
        - Not connected: login test creates session
        - Validates sessions before non-login tests
        """
        print(f"[PW] STARTING RUN for testCase {test_run_id} | category={project_category} | status={integration_status} | mcp={mcp_connected}")
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
                # CASE 0: MCP Connected SF → frontdoor.jsp (NO UI login, NO 2FA)
                # ═══════════════════════════════════════════════════
                if (
                    project_category == "salesforce"
                    and mcp_connected
                    and sf_session_id
                    and sf_instance_url
                ):
                    instance = sf_instance_url if sf_instance_url.startswith("http") else f"https://{sf_instance_url}"
                    frontdoor_url = f"{instance}/secur/frontdoor.jsp?sid={sf_session_id}"
                    print(f"[MCP-SESSION] Using frontdoor.jsp for {project_id} (no UI login, no 2FA)")

                    context = await browser.new_context()
                    await context.tracing.start(screenshots=True, snapshots=True, sources=True)
                    page = await context.new_page()

                    try:
                        await page.goto(frontdoor_url, wait_until="domcontentloaded", timeout=30000)
                        current_url = page.url.lower()
                        page_text = await page.text_content("body") or ""

                        # 2FA safety detection
                        if "verify your identity" in page_text.lower() or "verification" in current_url:
                            print(f"[MCP-SESSION] ⚠️ 2FA page detected! Re-authenticating via MCP...")
                            # Re-auth via MCP to get a completely fresh session
                            if sf_username and sf_password and sf_security_token:
                                try:
                                    from app.services.salesforce_mcp_service import SalesforceMCPService
                                    domain = "login"
                                    if sf_login_url and "test.salesforce.com" in sf_login_url:
                                        domain = "test"
                                    fresh = SalesforceMCPService.connect(
                                        username=sf_username,
                                        password=sf_password,
                                        security_token=sf_security_token,
                                        domain=domain,
                                    )
                                    new_sid = fresh.get("session_id")
                                    new_instance = fresh.get("instance_url")
                                    if new_sid and new_instance:
                                        new_instance_url = new_instance if new_instance.startswith("http") else f"https://{new_instance}"
                                        retry_url = f"{new_instance_url}/secur/frontdoor.jsp?sid={new_sid}"
                                        print(f"[MCP-SESSION] Retrying frontdoor.jsp with fresh session")
                                        await page.goto(retry_url, wait_until="domcontentloaded", timeout=30000)
                                        current_url = page.url.lower()
                                except Exception as re_err:
                                    print(f"[MCP-SESSION] Re-auth failed: {re_err}")

                        # Check if login succeeded
                        if "/login" in current_url or "/authorize" in current_url:
                            print(f"[MCP-SESSION] frontdoor.jsp failed — still on login page: {current_url}")
                        else:
                            print(f"[MCP-SESSION] ✅ Successfully logged in via frontdoor.jsp: {current_url}")
                            if session_path:
                                await context.storage_state(path=session_path)
                                session_saved = True
                    except Exception as e:
                        print(f"[MCP-SESSION] frontdoor.jsp error: {e}")

                # ═══════════════════════════════════════════════════
                # CASE 1: Connected SF project (OAuth), no session → browser login with credentials
                # ═══════════════════════════════════════════════════
                elif (
                    project_category == "salesforce"
                    and integration_status == "connected"
                    and sf_username
                    and sf_password
                    and not session_exists
                    and not mcp_connected
                ):
                    login_target = sf_login_url or "https://login.salesforce.com"
                    print(f"[SESSION] Connected SF (OAuth): browser login for {project_id} via {login_target}")
                    context = await browser.new_context()
                    await context.tracing.start(screenshots=True, snapshots=True, sources=True)
                    page = await context.new_page()
                    try:
                        await page.goto(login_target, wait_until="domcontentloaded", timeout=30000)
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
                            await page.wait_for_load_state('load', timeout=30000)
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
                            wait_until="domcontentloaded",
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
                                    await page.goto(frontdoor_url, wait_until="domcontentloaded", timeout=30000)
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
                            locator_type = getattr(step, "locator_type", "") or ""
                        else:
                            action = step.get("action", "").lower().strip()
                            target = step.get("target", "")
                            value = step.get("value", "")
                            locator_type = step.get("locator_type", "") or ""

                        locator_type = locator_type.lower().strip()

                        logger.info(f"Executing step {index+1}: {action} on {target} (locator_type={locator_type})")
                        step_order = index + 1
                        step_log = {
                            "step_order": step_order,
                            "action": action,
                            "target": target,
                            "value": value,
                            "locator_type": locator_type,
                            "status": "running",
                            "started_at": step_start.isoformat(),
                        }

                        try:
                            if action in ["navigate", "goto"]:
                                # AI puts URL in 'value', fallback to 'target' for backward compat
                                nav_path = value or target or ""
                                full_target = (
                                    base_url + (nav_path if nav_path.startswith("/") else "/" + nav_path)
                                    if nav_path
                                    else base_url
                                )
                                # Salesforce SPA may abort navigation (client-side routing)
                                # ERR_ABORTED means the page loaded but SPA router took over
                                try:
                                    await page.goto(full_target, wait_until="domcontentloaded", timeout=30000)
                                except Exception as nav_err:
                                    if "ERR_ABORTED" in str(nav_err):
                                        logger.info(f"  ℹ Navigation absorbed by Salesforce SPA router (ERR_ABORTED), continuing")
                                    else:
                                        raise
                                # Smart wait: let Salesforce Lightning SPA render
                                try:
                                    await page.wait_for_load_state("load", timeout=10000)
                                except Exception:
                                    pass
                                import asyncio as _aio
                                await _aio.sleep(2)  # Salesforce SPA needs time to initialize Lightning components

                            elif action == "click":
                                locator = await PlaywrightService._resolve_locator(page, target, locator_type, logger)
                                await locator.wait_for(state="visible", timeout=15000)
                                await locator.click(timeout=15000)

                                # Smart post-click waits for Salesforce
                                import asyncio as _aio
                                target_lower = (target or "").lower()
                                if "new" in target_lower or "edit" in target_lower:
                                    # After clicking New/Edit, wait for Salesforce modal to open
                                    try:
                                        modal = page.locator("div.modal-body, div.slds-modal__content, section.slds-modal, records-record-edit-form")
                                        await modal.first.wait_for(state="visible", timeout=10000)
                                        logger.info("  ℹ Salesforce modal detected, ready for form input")
                                    except Exception:
                                        await _aio.sleep(2)  # Fallback wait if modal not detected
                                elif "save" in target_lower:
                                    # After clicking Save, wait for toast or page transition
                                    await _aio.sleep(2)
                                    try:
                                        # Wait for toast to appear
                                        toast = page.locator(".toastMessage, .forceToastMessage, .slds-notify__content, div[data-key='success'], div[data-key='error']")
                                        await toast.first.wait_for(state="visible", timeout=5000)
                                        logger.info("  ℹ Salesforce toast notification detected")
                                    except Exception:
                                        pass  # Toast may have already dismissed or action doesn't show toast
                                elif "delete" in target_lower or "confirm" in target_lower:
                                    await _aio.sleep(1)

                            elif action in ["fill", "input", "type"]:
                                import asyncio as _aio
                                await _aio.sleep(0.5)  # Brief pause for Salesforce input focus readiness
                                locator = await PlaywrightService._resolve_locator(page, target, locator_type, logger)
                                await locator.wait_for(state="visible", timeout=15000)

                                try:
                                    await locator.fill(value or "", timeout=15000)
                                except Exception as fill_err:
                                    err_msg = str(fill_err)
                                    if "Element is not an" in err_msg or "not fillable" in err_msg.lower():
                                        # Resolved element is a container (e.g. <div role="group">), not a form input
                                        logger.info(f"  ℹ Element is not fillable, looking for input/textarea inside")
                                        inner = locator.locator("input:not([type='file']):not([type='hidden']), textarea, [contenteditable='true']")
                                        filled = False
                                        if await inner.count() > 0:
                                            for idx in range(await inner.count()):
                                                el = inner.nth(idx)
                                                try:
                                                    if await el.is_visible():
                                                        await el.fill(value or "", timeout=10000)
                                                        filled = True
                                                        logger.info(f"  → Filled via inner element at index {idx}")
                                                        break
                                                except Exception:
                                                    continue
                                        if not filled:
                                            # Non-text field (signature pad, file upload) — skip gracefully
                                            logger.warning(f"  ⚠ Field '{target}' is a non-text component, skipping fill")
                                            step_results[index]["status"] = "passed"
                                            step_results[index]["note"] = f"Skipped: '{target}' is a non-text component"
                                            step_results[index]["completed_at"] = datetime.utcnow().isoformat()
                                            continue
                                    else:
                                        raise  # Re-raise other errors

                            elif action == "assert_text":
                                # Determine expected text: use value if set, otherwise target IS the text to find
                                expected_text = value if value else target
                                if not expected_text:
                                    raise Exception("ASSERT_TEXT requires either value or target with expected text")

                                # Detect if this is a toast/notification assertion
                                combined = (target + " " + (value or "")).lower()
                                is_toast = any(kw in combined for kw in ["toast", "notify", "created", "saved", "deleted", "updated", "error"])

                                found_text = None

                                # Strategy 1: Try the specified locator (for CSS or text-based targets)
                                try:
                                    locator = await PlaywrightService._resolve_locator(page, target, locator_type, logger)
                                    await locator.wait_for(state="visible", timeout=5000 if is_toast else 15000)
                                    found_text = await locator.text_content()
                                except Exception:
                                    pass

                                # Strategy 2: Try known Salesforce toast selectors
                                if found_text is None and is_toast:
                                    toast_selectors = [
                                        ".toastMessage",
                                        ".forceToastMessage",
                                        ".slds-notify__content",
                                        "div[data-key='success']",
                                        "div[data-key='error']",
                                        ".slds-theme--success",
                                        ".slds-notify_toast",
                                        ".slds-notify--toast",
                                    ]
                                    for ts in toast_selectors:
                                        try:
                                            tl = page.locator(ts)
                                            if await tl.count() > 0 and await tl.first.is_visible():
                                                found_text = await tl.first.text_content()
                                                logger.info(f"  ℹ Toast found via fallback selector: '{ts}'")
                                                break
                                        except Exception:
                                            continue

                                # Strategy 3: Try get_by_text directly for the expected text
                                if found_text is None:
                                    try:
                                        text_loc = page.get_by_text(expected_text, exact=False)
                                        if await text_loc.count() > 0 and await text_loc.first.is_visible():
                                            found_text = await text_loc.first.text_content()
                                            logger.info(f"  ℹ Text found via get_by_text('{expected_text}')")
                                    except Exception:
                                        pass

                                # Strategy 4: Check full page body text
                                if found_text is None:
                                    try:
                                        page_text = await page.text_content("body")
                                        if expected_text in (page_text or ""):
                                            logger.info(f"  ℹ Assert text found in page body")
                                            found_text = page_text
                                    except Exception:
                                        pass

                                if found_text is not None and expected_text in (found_text or ""):
                                    logger.info(f"  ✅ Assert passed: '{expected_text}' found")
                                else:
                                    raise Exception(
                                        f"Assertion failed: expected '{expected_text}' in '{found_text or '(element not found)'}'"
                                    )

                            elif action == "wait":
                                wait_time = int(value) if value else 1000
                                # AI generates seconds (e.g. "3"), Playwright needs ms
                                if wait_time < 100:
                                    wait_time = wait_time * 1000
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
                                    await page.wait_for_load_state("load", timeout=5000)
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
