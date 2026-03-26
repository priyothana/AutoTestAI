"""
Playwright Core Service – shared execution scaffolding.

Provides the reusable browser launch, tracing, screenshot, step-loop,
timeout, and result-formatting logic.  Category-specific subclasses
(SalesforcePlaywrightService, WebPlaywrightService) override only:
    • _setup_session()   – browser context / login
    • _execute_step()    – per-action implementation
    • _resolve_locator() – element resolution strategy

The existing PlaywrightService for Salesforce is NOT changed in any
way.  This base class is imported *only* by the new WebPlaywrightService.
"""

from playwright.async_api import async_playwright
from datetime import datetime
import asyncio
import json
import os
import logging
import re

logger = logging.getLogger(__name__)

# Shared session directory
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SESSIONS_DIR = os.path.join(_BACKEND_DIR, "sessions")
os.makedirs(SESSIONS_DIR, exist_ok=True)


class PlaywrightCoreService:
    """Base class providing reusable Playwright test-execution utilities."""

    # ───────────────────────── Shared Utilities ─────────────────────────

    @staticmethod
    async def _first_visible(locator, description="", max_wait_ms=15000):
        """Wait until at least one element is in DOM, then find the first visible one."""
        start = datetime.utcnow()
        
        # 1. Wait for AT LEAST ONE element to attach
        attached = False
        while (datetime.utcnow() - start).total_seconds() * 1000 < max_wait_ms:
            if await locator.count() > 0:
                attached = True
                break
            await asyncio.sleep(0.5)
            
        if not attached:
            # Let it fail downstream with standard timeout error
            return locator.first

        # 2. Polling for visibility
        time_spent = (datetime.utcnow() - start).total_seconds() * 1000
        vis_wait = max(5000, max_wait_ms - time_spent)
        
        vis_start = datetime.utcnow()
        while (datetime.utcnow() - vis_start).total_seconds() * 1000 < vis_wait:
            count = await locator.count()
            for i in range(count):
                el = locator.nth(i)
                try:
                    if await el.is_visible():
                        logger.info(f"  → Visible match at index {i}/{count} for {description}")
                        return el
                except Exception:
                    continue
            await asyncio.sleep(0.5)

        logger.warning(f"  ⚠ No visible element after wait among {await locator.count()} matches for {description}")
        return locator.first

    @staticmethod
    async def _retry_action(action, retries=3, delay=2):
        """Retry an async action up to *retries* times."""
        last_err = None
        for attempt in range(retries):
            try:
                return await action()
            except Exception as e:
                last_err = e
                if attempt < retries - 1:
                    logger.info(f"  ℹ Attempt {attempt+1}/{retries} failed, retrying in {delay}s…")
                    await asyncio.sleep(delay)
        raise last_err

    @staticmethod
    async def _safe_click(page, locator, timeout=15000):
        """Generic safe click: scroll → visible → click."""
        try:
            await locator.wait_for(state="attached", timeout=timeout)
        except Exception:
            pass

        try:
            await locator.scroll_into_view_if_needed(timeout=5000)
        except Exception:
            pass
        await locator.wait_for(state="visible", timeout=10000)
        await locator.click(timeout=10000)
        logger.info("  → safe_click succeeded")

    # ───────────────────────── Locator Resolution ─────────────────────────

    @staticmethod
    async def _resolve_locator(page, target, locator_type):
        """
        Generic locator resolver for web applications.
        Supports: role, text, label, css, placeholder, testid.
        """
        locator_type = (locator_type or "").lower().strip()

        # ── Auto-detect from target pattern ──
        if not locator_type and target:
            if re.match(r"role=\w+,\s*name=", target):
                locator_type = "role"
            elif target.startswith("label="):
                locator_type = "label"
                target = target[6:]
            elif target.startswith("text="):
                locator_type = "text"
                target = target[5:]
            elif target.startswith("testid="):
                locator_type = "testid"
                target = target[7:]
            elif target.startswith("placeholder="):
                locator_type = "placeholder"
                target = target[12:]
            elif not re.search(r'[.#\[\]>:=]', target):
                locator_type = "text"  # plain text → search by text

        # ── Resolution by type ──
        if locator_type == "role":
            role_match = re.match(r"role=(\w+),\s*name=(.+)", target)
            if role_match:
                role, name = role_match.group(1).strip(), role_match.group(2).strip()
                loc = page.get_by_role(role, name=name, exact=False)
                return await PlaywrightCoreService._first_visible(loc, f"role={role} name={name}")
            else:
                return await PlaywrightCoreService._first_visible(page.locator(target), f"css={target}")

        elif locator_type == "label":
            # Try get_by_label first
            loc = page.get_by_label(target, exact=False)
            if await loc.count() > 0:
                return await PlaywrightCoreService._first_visible(loc, f"label='{target}'")
            # Fallback: role textbox by name
            tb = page.get_by_role("textbox", name=target, exact=False)
            if await tb.count() > 0:
                return await PlaywrightCoreService._first_visible(tb, f"textbox name='{target}'")
            # Fallback: placeholder
            ph = page.get_by_placeholder(target, exact=False)
            return await PlaywrightCoreService._first_visible(ph, f"placeholder='{target}'")

        elif locator_type == "text":
            loc = page.get_by_text(target, exact=False)
            return await PlaywrightCoreService._first_visible(loc, f"text='{target}'")

        elif locator_type == "css":
            return await PlaywrightCoreService._first_visible(page.locator(target), f"css='{target}'")

        elif locator_type == "testid":
            return await PlaywrightCoreService._first_visible(page.get_by_test_id(target), f"testid='{target}'")

        elif locator_type == "placeholder":
            loc = page.get_by_placeholder(target, exact=False)
            return await PlaywrightCoreService._first_visible(loc, f"placeholder='{target}'")

        else:
            # Auto: try CSS first, then text
            try:
                loc = page.locator(target)
                if await loc.count() > 0:
                    return await PlaywrightCoreService._first_visible(loc, f"auto css='{target}'")
            except Exception:
                pass
            loc = page.get_by_text(target, exact=False)
            if await loc.count() > 0:
                return await PlaywrightCoreService._first_visible(loc, f"auto text='{target}'")
            return await PlaywrightCoreService._first_visible(page.locator(target), f"auto fallback='{target}'")

    # ───────────────────────── Execution Engine ─────────────────────────

    @classmethod
    async def execute_test_case(
        cls,
        test_run_id: str,
        base_url: str,
        steps: list,
        project_id: str = None,
        **kwargs,
    ):
        """
        Run a list of test steps in a headless browser.
        Subclasses customise behaviour by overriding _execute_step().
        """
        logger.info(f"[CORE] STARTING RUN {test_run_id} | base_url={base_url}")
        logs = []
        overall_result = "passed"
        start_time = datetime.utcnow()
        final_path = None

        # Screenshot directory
        screenshot_base_dir = "static/test-runs"
        run_screenshot_dir = os.path.join(screenshot_base_dir, test_run_id)
        os.makedirs(run_screenshot_dir, exist_ok=True)

        async def run_logic():
            nonlocal overall_result, final_path
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                context = await browser.new_context()
                await context.tracing.start(screenshots=True, snapshots=True, sources=True)
                page = await context.new_page()
                page.set_default_timeout(30_000)
                page.set_default_navigation_timeout(45_000)

                try:
                    for index, step in enumerate(steps):
                        step_start = datetime.utcnow()

                        # Normalise step data
                        if hasattr(step, "action"):
                            action = step.action.lower().strip()
                            target = step.target
                            value  = step.value
                            locator_type = getattr(step, "locator_type", "") or ""
                        else:
                            action = step.get("action", "").lower().strip()
                            target = step.get("target", "")
                            value  = step.get("value", "")
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
                            # Delegate to subclass
                            await cls._execute_step(
                                page, action, target, value, locator_type,
                                base_url=base_url,
                                step_order=step_order,
                                logs=logs,
                                **kwargs,
                            )
                            step_log["status"] = "success"
                            logger.info(f"  ✅ STEP {step_order} SUCCESS: {action}")

                        except Exception as e:
                            logger.info(f"  ❌ STEP {step_order} FAILED: {action} – {e}")
                            step_log["status"] = "failed"
                            step_log["error"] = str(e)
                            overall_result = "failed"

                            # Error screenshot
                            err_path = os.path.join(run_screenshot_dir, "error.png")
                            await page.screenshot(path=err_path, full_page=True)
                            final_path = f"/static/test-runs/{test_run_id}/error.png"
                            step_log["screenshot_url"] = final_path

                            step_log["ended_at"] = datetime.utcnow().isoformat()
                            step_log["duration_ms"] = (datetime.utcnow() - step_start).total_seconds() * 1000
                            logs.append(step_log)
                            break  # stop on first failure

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
            "session_saved": False,
            "session_expired": False,
        }

    # ──────────── Hook for subclasses (must be overridden) ────────────

    @classmethod
    async def _execute_step(cls, page, action, target, value, locator_type, **kwargs):
        """Override in subclass to implement each test action."""
        raise NotImplementedError("Subclasses must implement _execute_step()")
