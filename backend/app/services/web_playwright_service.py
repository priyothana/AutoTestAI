"""
Web Application Playwright Service

Subclass of PlaywrightCoreService for testing standard web applications.
Implements:
    • Auto-login using stored credentials (form-based)
    • Session reuse via storageState.json (like Salesforce)
    • Generic browser actions: navigate, click, fill, select, hover,
      assert_text, assert_visible, assert_url, wait, etc.

This service is ONLY used when project_category == "webapp".
The Salesforce path remains completely untouched.
"""

from app.services.playwright_core_service import PlaywrightCoreService, SESSIONS_DIR
from playwright.async_api import async_playwright
from datetime import datetime
import asyncio
import os
import re
import logging

logger = logging.getLogger(__name__)


class WebPlaywrightService(PlaywrightCoreService):
    """Web-application test executor with auto-login & session reuse."""

    # ─────────────── Override execute_test_case for session handling ───────────────

    @classmethod
    async def execute_test_case(
        cls,
        test_run_id: str,
        base_url: str,
        steps: list,
        project_id: str = None,
        web_username: str = None,
        web_password: str = None,
        web_login_url: str = None,
        web_login_strategy: str = "form",
        **kwargs,
    ):
        """
        Execute test steps with optional auto-login + session reuse.

        If web_username/web_password are provided:
            1. Try to load an existing session (storageState.json)
            2. If no session → auto-login via form, then save session
            3. Execute the test steps
        """
        logger.info(
            f"[WEB] STARTING RUN {test_run_id} | base_url={base_url} "
            f"| has_creds={bool(web_username)} | strategy={web_login_strategy}"
        )
        logs = []
        overall_result = "passed"
        start_time = datetime.utcnow()
        final_path = None
        session_saved = False

        # Screenshot directory
        screenshot_base_dir = "static/test-runs"
        run_screenshot_dir = os.path.join(screenshot_base_dir, test_run_id)
        os.makedirs(run_screenshot_dir, exist_ok=True)

        # Session file (per-project)
        session_path = None
        if project_id:
            session_path = os.path.join(SESSIONS_DIR, f"{project_id}_web.json")

        async def run_logic():
            nonlocal overall_result, final_path, session_saved
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)

                # ═══════════════════════════════════════════
                # SESSION MANAGEMENT
                # ═══════════════════════════════════════════
                context = None
                page = None
                session_loaded = False

                # Try loading existing session
                if session_path and os.path.exists(session_path):
                    try:
                        context = await browser.new_context(storage_state=session_path)
                        page = await context.new_page()
                        page.set_default_timeout(30_000)
                        page.set_default_navigation_timeout(45_000)
                        await context.tracing.start(screenshots=True, snapshots=True, sources=True)

                        # Validate session: navigate to base_url and check we're not on login page
                        await page.goto(base_url, wait_until="domcontentloaded", timeout=30_000)
                        await asyncio.sleep(2)
                        current_url = page.url.lower()

                        # If redirected to login page, session is expired
                        login_indicators = ["/login", "/signin", "/auth", "/sso", "/cas/login"]
                        is_on_login = any(ind in current_url for ind in login_indicators)

                        if is_on_login:
                            logger.info("[WEB-SESSION] Session expired (redirected to login page)")
                            await context.tracing.stop()
                            await context.close()
                            if os.path.exists(session_path):
                                os.remove(session_path)
                            context = None
                            page = None
                        else:
                            session_loaded = True
                            logger.info(f"[WEB-SESSION] ✅ Session loaded and valid: {page.url}")
                    except Exception as e:
                        logger.warning(f"[WEB-SESSION] Failed to load session: {e}")
                        if context:
                            try:
                                await context.tracing.stop()
                                await context.close()
                            except Exception:
                                pass
                        context = None
                        page = None
                        if session_path and os.path.exists(session_path):
                            os.remove(session_path)

                # Create fresh context if no session loaded
                if context is None:
                    context = await browser.new_context()
                    await context.tracing.start(screenshots=True, snapshots=True, sources=True)
                    page = await context.new_page()
                    page.set_default_timeout(30_000)
                    page.set_default_navigation_timeout(45_000)

                # ═══════════════════════════════════════════
                # AUTO-LOGIN (if credentials exist and no session)
                # ═══════════════════════════════════════════
                if web_username and web_password and not session_loaded:
                    login_target = web_login_url or base_url
                    logger.info(f"[WEB-LOGIN] Auto-login to {login_target} as '{web_username}'")

                    try:
                        await page.goto(login_target, wait_until="domcontentloaded", timeout=30_000)
                        await asyncio.sleep(1)

                        if web_login_strategy == "form":
                            # ── Generic form login ──
                            # Find username field (common selectors)
                            username_selectors = [
                                'input[name="username"]', 'input[name="email"]',
                                'input[name="user"]', 'input[name="login"]',
                                'input[type="email"]', 'input[id="username"]',
                                'input[id="email"]', 'input[id="user"]',
                                'input[autocomplete="username"]',
                                'input[autocomplete="email"]',
                            ]
                            username_field = None
                            for sel in username_selectors:
                                try:
                                    loc = page.locator(sel)
                                    if await loc.count() > 0 and await loc.first.is_visible():
                                        username_field = loc.first
                                        logger.info(f"  → Username field found via: {sel}")
                                        break
                                except Exception:
                                    continue

                            if not username_field:
                                # Fallback: first visible text/email input
                                try:
                                    all_inputs = page.locator('input[type="text"], input[type="email"], input:not([type])')
                                    for i in range(await all_inputs.count()):
                                        inp = all_inputs.nth(i)
                                        if await inp.is_visible():
                                            username_field = inp
                                            logger.info(f"  → Username field found via fallback (index {i})")
                                            break
                                except Exception:
                                    pass

                            # Find password field
                            password_field = None
                            try:
                                pwd_loc = page.locator('input[type="password"]')
                                if await pwd_loc.count() > 0:
                                    password_field = pwd_loc.first
                            except Exception:
                                pass

                            if username_field and password_field:
                                await username_field.click(timeout=5_000)
                                await username_field.fill(web_username)
                                await password_field.click(timeout=5_000)
                                await password_field.fill(web_password)

                                # Find and click the submit button
                                submit_selectors = [
                                    'button[type="submit"]',
                                    'input[type="submit"]',
                                    'button:has-text("Log in")',
                                    'button:has-text("Login")',
                                    'button:has-text("Sign in")',
                                    'button:has-text("Sign In")',
                                    'button:has-text("Submit")',
                                    'a:has-text("Log in")',
                                    'a:has-text("Login")',
                                    '#loginButton', '#login-button',
                                    '#submitBtn', '.login-btn',
                                ]
                                clicked = False
                                for sel in submit_selectors:
                                    try:
                                        btn = page.locator(sel)
                                        if await btn.count() > 0 and await btn.first.is_visible():
                                            await btn.first.click(timeout=10_000)
                                            clicked = True
                                            logger.info(f"  → Submit clicked via: {sel}")
                                            break
                                    except Exception:
                                        continue

                                if not clicked:
                                    # Fallback: press Enter
                                    await page.keyboard.press("Enter")
                                    logger.info("  → Submit via Enter key (no button found)")

                                # Wait for redirect away from login page
                                try:
                                    await page.wait_for_load_state("load", timeout=15_000)
                                except Exception:
                                    pass
                                await asyncio.sleep(3)

                                # Check if login succeeded
                                current_url = page.url.lower()
                                login_indicators = ["/login", "/signin", "/auth", "/sso", "/cas/login"]
                                still_on_login = any(ind in current_url for ind in login_indicators)

                                if still_on_login:
                                    logger.warning(f"[WEB-LOGIN] ⚠ May still be on login page: {page.url}")
                                else:
                                    logger.info(f"[WEB-LOGIN] ✅ Login succeeded: {page.url}")
                                    # Save session for reuse
                                    if session_path:
                                        await context.storage_state(path=session_path)
                                        session_saved = True
                                        logger.info(f"[WEB-SESSION] Session saved for project {project_id}")
                            else:
                                logger.warning(
                                    f"[WEB-LOGIN] ⚠ Could not find login form fields "
                                    f"(username={bool(username_field)}, password={bool(password_field)})"
                                )
                    except Exception as login_err:
                        logger.error(f"[WEB-LOGIN] Auto-login failed: {login_err}")

                # ═══════════════════════════════════════════
                # EXECUTE TEST STEPS
                # ═══════════════════════════════════════════
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
                        step_order = index + 1
                        logger.info(f"Step {step_order}: {action} on {target} (locator={locator_type})")

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
                            await cls._execute_step(
                                page, action, target, value, locator_type,
                                base_url=base_url,
                            )
                            step_log["status"] = "success"
                            logger.info(f"  ✅ STEP {step_order} SUCCESS: {action}")

                        except Exception as e:
                            logger.info(f"  ❌ STEP {step_order} FAILED: {action} – {e}")
                            step_log["status"] = "failed"
                            step_log["error"] = str(e)
                            overall_result = "failed"

                            err_path = os.path.join(run_screenshot_dir, "error.png")
                            await page.screenshot(path=err_path, full_page=True)
                            final_path = f"/static/test-runs/{test_run_id}/error.png"
                            step_log["screenshot_url"] = final_path

                            step_log["ended_at"] = datetime.utcnow().isoformat()
                            step_log["duration_ms"] = (datetime.utcnow() - step_start).total_seconds() * 1000
                            logs.append(step_log)
                            break

                        step_log["ended_at"] = datetime.utcnow().isoformat()
                        step_log["duration_ms"] = (datetime.utcnow() - step_start).total_seconds() * 1000
                        logs.append(step_log)

                    # Final screenshot on success
                    if overall_result == "passed":
                        ok_path = os.path.join(run_screenshot_dir, "final.png")
                        await page.screenshot(path=ok_path, full_page=True)
                        final_path = f"/static/test-runs/{test_run_id}/final.png"

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

        try:
            await asyncio.wait_for(run_logic(), timeout=600)
        except asyncio.TimeoutError:
            logger.error(f"Run {test_run_id} TIMED OUT after 10 minutes")
            overall_result = "timeout"
            logs.append({
                "step_order": 999,
                "action": "SYSTEM",
                "error": "Global timeout exceeded (10 minutes)",
                "status": "timeout",
                "started_at": datetime.utcnow().isoformat(),
            })
        except Exception as e:
            logger.error(f"Unexpected error: {e}")
            overall_result = "error"
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
            "session_expired": False,
        }

    # ─────────────── Step Executor ───────────────

    @classmethod
    async def _execute_step(cls, page, action, target, value, locator_type, **kwargs):
        """
        Execute a single test step for a generic web application.

        Supported actions:
            navigate / goto, click, fill / input / type, select,
            hover, check / uncheck, press_key, scroll, upload,
            assert_text, assert_visible, assert_url, assert_title, wait
        """
        base_url = kwargs.get("base_url", "")

        # ── Navigation ──
        if action in ("navigate", "goto"):
            nav_target = value or target or ""
            if nav_target.startswith("http://") or nav_target.startswith("https://"):
                full_url = nav_target
            elif nav_target:
                full_url = base_url.rstrip("/") + "/" + nav_target.lstrip("/")
            else:
                full_url = base_url
            await page.goto(full_url, wait_until="domcontentloaded", timeout=45_000)
            try:
                await page.wait_for_load_state("load", timeout=15_000)
            except Exception:
                pass
            logger.info(f"  ✅ Navigated to {page.url}")

        # ── Click ──
        elif action == "click":
            loc = await cls._resolve_locator(page, target, locator_type)

            # ── Smart Click with fallback ──
            # Try the exact locator first (quick check)
            try:
                await loc.wait_for(state="visible", timeout=15000)
                await cls._safe_click(page, loc)
                await asyncio.sleep(1)
                try:
                    await page.wait_for_load_state("networkidle", timeout=5000)
                except Exception:
                    pass
                logger.info(f"  ✅ Click succeeded on primary locator: {target}")
            except Exception as primary_err:
                logger.warning(f"  ⚠ Primary locator failed for '{target}': {primary_err}")

                # ── Fallback: Smart Button Discovery ──
                # Extract the button name from the target for semantic matching
                role_match = re.match(r"role=(\w+),\s*name=(.+)", target or "")
                if role_match:
                    requested_role = role_match.group(1).strip().lower()
                    requested_name = role_match.group(2).strip().lower()

                    # Define semantic equivalents for common action buttons
                    _BUTTON_SYNONYMS = {
                        "save":    ["save", "create", "submit", "confirm", "done", "apply", "ok"],
                        "create":  ["create", "save", "submit", "add", "new", "confirm"],
                        "submit":  ["submit", "save", "create", "confirm", "send", "done"],
                        "cancel":  ["cancel", "close", "dismiss", "back", "discard"],
                        "delete":  ["delete", "remove", "trash", "discard"],
                        "edit":    ["edit", "modify", "update", "change"],
                        "new":     ["new", "create", "add", "new opportunity", "new contact", "new account", "new lead"],
                        "add":     ["add", "new", "create", "add record", "add new"],
                        "add record": ["add record", "add", "new", "create", "new record"],
                    }

                    # Get synonyms for the requested button name
                    synonyms = set()
                    for key, vals in _BUTTON_SYNONYMS.items():
                        if requested_name in vals or key == requested_name:
                            synonyms.update(vals)
                    if not synonyms:
                        synonyms = {requested_name}

                    logger.info(f"  🔍 Smart Button Discovery: looking for synonyms of '{requested_name}': {synonyms}")

                    # Scan all visible buttons/links on the page
                    found_fallback = False
                    try:
                        all_buttons = await page.evaluate("""() => {
                            const results = [];
                            const els = document.querySelectorAll(
                                'button, a[role="button"], input[type="submit"], [role="button"]'
                            );
                            for (const el of els) {
                                const rect = el.getBoundingClientRect();
                                if (rect.width > 0 && rect.height > 0) {
                                    const text = (el.textContent || '').trim();
                                    const title = el.getAttribute('title') || '';
                                    const ariaLabel = el.getAttribute('aria-label') || '';
                                    if (text || title || ariaLabel) {
                                        results.push({
                                            text: text,
                                            title: title,
                                            ariaLabel: ariaLabel,
                                            tag: el.tagName.toLowerCase()
                                        });
                                    }
                                }
                            }
                            return results;
                        }""")
                        logger.info(f"  🔍 Found {len(all_buttons)} visible buttons on page: {[b.get('text','')[:30] for b in all_buttons]}")

                        # Score each button against synonyms
                        best_match = None
                        best_score = 0
                        for btn_info in all_buttons:
                            btn_text = (btn_info.get("text", "") or "").strip().lower()
                            btn_title = (btn_info.get("title", "") or "").strip().lower()
                            btn_aria = (btn_info.get("ariaLabel", "") or "").strip().lower()
                            all_labels = [btn_text, btn_title, btn_aria]

                            for synonym in synonyms:
                                for label in all_labels:
                                    if not label:
                                        continue
                                    # Exact match = highest score
                                    if label == synonym:
                                        score = 100
                                    # Label contains synonym word (e.g. "Create Account" contains "create")
                                    elif synonym in label.split():
                                        score = 80
                                    # Partial containment
                                    elif synonym in label:
                                        score = 60
                                    # Requested name appears in the label (e.g. searching "Save" and button says "Save & New")
                                    elif requested_name in label:
                                        score = 70
                                    else:
                                        continue

                                    if score > best_score:
                                        best_score = score
                                        best_match = btn_info
                                        logger.info(f"  🔍 Candidate: '{label}' (score={score}, synonym='{synonym}')")

                        if best_match and best_score >= 60:
                            match_text = best_match.get("text", "").strip()
                            match_title = best_match.get("title", "").strip()
                            match_label = match_text or match_title or best_match.get("ariaLabel", "").strip()
                            logger.info(f"  ✅ Smart Button Discovery: matched '{match_label}' (score={best_score})")

                            # Build a locator for the matched button
                            fallback_loc = None
                            if match_title:
                                fallback_loc = page.locator(f"button[title='{match_title}'], a[title='{match_title}'], [role='button'][title='{match_title}']")
                            if not fallback_loc or await fallback_loc.count() == 0:
                                fallback_loc = page.get_by_role("button", name=match_label, exact=False)
                            if await fallback_loc.count() == 0 and match_text:
                                fallback_loc = page.locator(f"button:has-text('{match_text}'), a:has-text('{match_text}')")

                            if await fallback_loc.count() > 0:
                                fb_el = await cls._first_visible(fallback_loc, f"fallback '{match_label}'")
                                await cls._safe_click(page, fb_el)
                                await asyncio.sleep(0.5)
                                found_fallback = True
                                logger.info(f"  ✅ Smart fallback click succeeded on '{match_label}'")
                            else:
                                logger.warning(f"  ⚠ Smart Button: matched '{match_label}' but locator returned 0 elements")

                    except Exception as scan_err:
                        logger.warning(f"  ⚠ Smart Button Discovery scan failed: {scan_err}")

                    if not found_fallback:
                        raise primary_err
                else:
                    # Not a role-based target, re-raise original error
                    raise primary_err

        # ── Fill / Type ──
        elif action in ("fill", "input", "type"):
            loc = await cls._resolve_locator(page, target, locator_type)
            await loc.wait_for(state="visible", timeout=10_000)
            await loc.click(timeout=5_000)
            if action == "type":
                await loc.press("Control+a")
                await page.keyboard.type(value or "", delay=50)
            else:
                await loc.fill(value or "")
            await page.keyboard.press("Tab")
            await asyncio.sleep(0.3)
            logger.info(f"  ✅ Filled '{target}' with '{value}'")

        # ── Select ──
        elif action == "select":
            loc = await cls._resolve_locator(page, target, locator_type)
            await loc.wait_for(state="visible", timeout=10_000)
            await loc.select_option(value=value, timeout=5_000)
            logger.info(f"  ✅ Selected '{value}' in '{target}'")

        # ── Hover ──
        elif action == "hover":
            loc = await cls._resolve_locator(page, target, locator_type)
            await loc.wait_for(state="visible", timeout=10_000)
            await loc.hover()

        # ── Check / Uncheck ──
        elif action == "check":
            loc = await cls._resolve_locator(page, target, locator_type)
            await loc.check(timeout=10_000)

        elif action == "uncheck":
            loc = await cls._resolve_locator(page, target, locator_type)
            await loc.uncheck(timeout=10_000)

        # ── Press Key ──
        elif action == "press_key":
            await page.keyboard.press(value or target or "Enter")

        # ── Scroll ──
        elif action == "scroll":
            pixels = int(value) if value else 300
            if target:
                loc = await cls._resolve_locator(page, target, locator_type)
                await loc.evaluate(f"el => el.scrollBy(0, {pixels})")
            else:
                await page.evaluate(f"window.scrollBy(0, {pixels})")

        # ── Upload ──
        elif action == "upload":
            loc = await cls._resolve_locator(page, target, locator_type)
            await loc.set_input_files(value or "")

        # ── Assert Text ──
        elif action == "assert_text":
            expected = value if value else target
            if not expected:
                raise Exception("assert_text requires expected text")
            found = False
            # Strategy 1: specific locator
            if target and value:
                try:
                    loc = await cls._resolve_locator(page, target, locator_type)
                    await loc.wait_for(state="visible", timeout=10_000)
                    text = await loc.text_content()
                    if expected.lower() in (text or "").lower():
                        found = True
                except Exception:
                    pass
            # Strategy 2: get_by_text
            if not found:
                try:
                    tl = page.get_by_text(expected, exact=False)
                    if await tl.count() > 0:
                        await tl.first.wait_for(state="visible", timeout=5_000)
                        found = True
                except Exception:
                    pass
            # Strategy 3: body text
            if not found:
                body = await page.text_content("body") or ""
                if expected.lower() in body.lower():
                    found = True
            if not found:
                raise Exception(f"Assertion failed: expected '{expected}' not found on page")
            logger.info(f"  ✅ Assert text passed: '{expected}'")

        # ── Assert Visible ──
        elif action == "assert_visible":
            loc = await cls._resolve_locator(page, target, locator_type)
            await loc.wait_for(state="visible", timeout=15_000)

        # ── Assert URL ──
        elif action == "assert_url":
            # Wait for any pending navigation after previous actions
            try:
                await page.wait_for_load_state("load", timeout=10_000)
            except Exception:
                pass
            await asyncio.sleep(1)
            frag = (value or target or "").strip().rstrip("/")
            current = page.url.lower().rstrip("/")
            frag_lower = frag.lower()
            if frag_lower not in current:
                raise Exception(f"URL assertion failed: '{frag}' not in '{page.url}'")

        # ── Assert Title ──
        elif action == "assert_title":
            exp = value or target or ""
            actual = await page.title()
            if exp.lower() not in actual.lower():
                raise Exception(f"Title assertion failed: '{exp}' not in '{actual}'")

        # ── Wait ──
        elif action == "wait":
            ms = int(value) if value else 1000
            if ms < 100:
                ms *= 1000
            await page.wait_for_timeout(ms)

        else:
            logger.warning(f"  ⚠ Unsupported web action: {action}")
