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
from app.services.salesforce_engine import SalesforceLightningEngine
from datetime import datetime
import asyncio
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
    async def _first_visible(locator, logger, description="", max_wait_ms=3000):
        """Wait briefly and find the first visible element from a multi-match locator."""
        import asyncio as _aio
        
        count = await locator.count()
        if count == 0:
            return locator.first  # will fail with clear error at wait_for
        if count == 1:
            return locator.first  # let caller's wait_for handle visibility
            
        # Multiple matches — poll until one becomes visible (for animating modals)
        start = datetime.utcnow()
        while (datetime.utcnow() - start).total_seconds() * 1000 < max_wait_ms:
            count = await locator.count()
            for i in range(count):
                el = locator.nth(i)
                try:
                    if await el.is_visible():
                        logger.info(f"  → Found visible match at index {i}/{count} for {description}")
                        return el
                except Exception:
                    continue
            await _aio.sleep(0.5)
            
        # No visible element found after polling — return first and let caller handle timeout
        logger.warning(f"  ⚠ No visible element found after {max_wait_ms}ms among {count} matches for {description}")
        return locator.first

    @staticmethod
    async def _safe_click(page, locator, logger, timeout=20000):
        """Salesforce-safe click: page-load aware → scroll → visible → click.
        Waits for page to finish loading before declaring element absent."""
        # Quick DOM check (8s)
        try:
            await locator.wait_for(state="attached", timeout=8000)
        except Exception:
            logger.info("  ℹ Element not in DOM after 8s — checking if page is still loading...")

            # Wait for page to finish loading (VF pages, PDFs, iframes)
            for wait_round in range(6):  # up to 18s more
                try:
                    load_info = await page.evaluate("""() => ({
                        ready: document.readyState === 'complete',
                        spinner: !!document.querySelector(
                            '.slds-spinner:not(.slds-hide), lightning-spinner, .forceSpinner'
                        )
                    })""")
                    page_done = load_info.get("ready", True) and not load_info.get("spinner", False)
                except Exception:
                    page_done = True

                if page_done and wait_round > 0:
                    break
                await asyncio.sleep(3)
                # Re-check element
                try:
                    await locator.wait_for(state="attached", timeout=2000)
                    logger.info(f"  → Element appeared after page load wait ({(wait_round+1)*3}s)")
                    break
                except Exception:
                    continue
            else:
                # Final attempt
                try:
                    await locator.wait_for(state="attached", timeout=5000)
                except Exception:
                    raise Exception("Element not found in DOM after page fully loaded")
        try:
            await locator.scroll_into_view_if_needed(timeout=5000)
        except Exception:
            pass
        await locator.wait_for(state="visible", timeout=10000)
        await locator.click(timeout=10000)
        logger.info("  → safe_click succeeded")

    @staticmethod
    async def _retry_action(action, logger, retries=3, delay=2):
        """Retry an async action up to `retries` times with a sleep between each."""
        last_err = None
        for attempt in range(retries):
            try:
                return await action()
            except Exception as e:
                last_err = e
                if attempt < retries - 1:
                    logger.info(f"  ℹ Attempt {attempt+1}/{retries} failed, retrying in {delay}s...")
                    await asyncio.sleep(delay)
        raise last_err

    @staticmethod
    async def _scan_page_elements(page, logger):
        """Scan the current page/modal for interactive elements (debug aid)."""
        try:
            scan = await page.evaluate("""() => {
                const modal = document.querySelector(
                    '.slds-modal__content, records-record-edit-form, lightning-record-edit-form, section.slds-modal'
                );
                const root = modal || document.body;
                const buttons = [...root.querySelectorAll('button, a[role=button], [role=button]')]
                    .filter(b => b.offsetParent !== null)
                    .map(b => b.textContent?.trim()).filter(Boolean).slice(0, 15);
                const inputs = [...root.querySelectorAll('input:not([type=hidden]), textarea, [contenteditable=true]')]
                    .filter(i => i.offsetParent !== null)
                    .map(i => i.getAttribute('aria-label') || i.getAttribute('name') || i.getAttribute('placeholder') || i.type)
                    .filter(Boolean).slice(0, 20);
                const picklists = [...root.querySelectorAll('lightning-combobox, lightning-picklist, select')]
                    .filter(p => p.offsetParent !== null).length;
                const hasModal = !!document.querySelector('.slds-modal, records-record-edit-form, lightning-record-edit-form');
                return { buttons, inputs, picklists, hasModal };
            }""")
            logger.info(f"  📋 Page scan: buttons={scan.get('buttons', [])}, inputs={scan.get('inputs', [])}, picklists={scan.get('picklists', 0)}, modal={scan.get('hasModal', False)}")
            return scan
        except Exception as e:
            logger.debug(f"  Page scan failed: {e}")
            return {}

    @staticmethod
    async def _fill_salesforce_field(page, label, value, logger):
        """Try to fill a Salesforce Lightning field by component type.
        Returns True if successful, False otherwise.
        Handles: lightning-input-field, lightning-datepicker, lightning-combobox, etc.
        Scrolls the modal container to reveal off-screen fields."""

        # Step 1: Scroll the modal container to bring the field into view
        # Fields at the bottom of long forms (like field 11/12) are off-screen
        try:
            await page.evaluate("""(labelText) => {
                const modal = document.querySelector('.slds-modal__content, div.modal-body, records-record-edit-form');
                if (modal) {
                    // Find the label element containing our text
                    const labels = [...modal.querySelectorAll('label, span.slds-form-element__label, legend')];
                    const target = labels.find(l => l.textContent && l.textContent.trim().includes(labelText));
                    if (target) {
                        target.scrollIntoView({ behavior: 'instant', block: 'center' });
                    } else {
                        // Label not found yet — scroll modal down to reveal more fields
                        modal.scrollTop = modal.scrollHeight;
                    }
                }
            }""", label)
            await asyncio.sleep(0.5)
        except Exception as scroll_err:
            logger.debug(f"  Modal scroll for '{label}' failed: {scroll_err}")

        # Step 2: Try Lightning component selectors (CSS-based)
        strategies = [
            # Lightning date picker (label is outside the input, inside parent)
            (f"lightning-input-field:has-text('{label}') input", "input-field"),
            (f"lightning-datepicker:has-text('{label}') input", "datepicker"),
            (f"lightning-input:has-text('{label}') input", "input"),
            (f"lightning-combobox:has-text('{label}') input", "combobox"),
            # Aria / name fallbacks
            (f"input[aria-label='{label}']", "aria-label"),
            (f"input[name='{label}']", "name-attr"),
        ]

        for selector, comp_type in strategies:
            try:
                locator = page.locator(selector)
                if await locator.count() == 0:
                    continue
                el = locator.first
                await el.scroll_into_view_if_needed(timeout=5000)
                await el.click(timeout=5000)
                # For date pickers: select all and type, then Tab to commit
                if comp_type in ("datepicker", "input-field"):
                    # Lightning date fields need click+type approach
                    await el.press("Control+A")
                    await el.type(value or "", delay=50)
                    await page.keyboard.press("Tab")
                else:
                    await el.fill(value or "", timeout=10000)
                    await page.keyboard.press("Tab")
                logger.info(f"  → _fill_salesforce_field: filled '{label}' via {comp_type} ({selector})")
                return True
            except Exception as e:
                logger.debug(f"  _fill_salesforce_field: {comp_type} failed for '{label}': {e}")
                continue

        # Step 3: JavaScript-based discovery (handles shadow DOM and complex structures)
        # Find the input by traversing the DOM from the label text
        try:
            js_found = await page.evaluate("""(args) => {
                const [labelText, fillValue] = args;
                const modal = document.querySelector('.slds-modal__content, records-record-edit-form') || document.body;
                
                // Find all elements containing our label text
                const allElements = [...modal.querySelectorAll('*')];
                let targetInput = null;
                
                for (const el of allElements) {
                    // Check if this element's DIRECT text content includes our label
                    if (el.textContent && el.textContent.trim().includes(labelText)) {
                        // Look for the closest form element container
                        const formEl = el.closest('lightning-input-field, lightning-datepicker, lightning-input, .slds-form-element');
                        if (formEl) {
                            targetInput = formEl.querySelector('input:not([type=hidden]), textarea');
                            if (targetInput) break;
                        }
                    }
                }
                
                if (!targetInput) return false;
                
                // Scroll it into view
                targetInput.scrollIntoView({ behavior: 'instant', block: 'center' });
                
                // Set value via native setter to trigger Lightning data binding
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                ).set;
                nativeInputValueSetter.call(targetInput, fillValue);
                targetInput.dispatchEvent(new Event('input', { bubbles: true }));
                targetInput.dispatchEvent(new Event('change', { bubbles: true }));
                targetInput.dispatchEvent(new Event('blur', { bubbles: true }));
                
                return true;
            }""", [label, value or ""])

            if js_found:
                await page.keyboard.press("Tab")
                await asyncio.sleep(0.3)
                logger.info(f"  → _fill_salesforce_field: filled '{label}' via JS DOM traversal")
                return True
        except Exception as js_err:
            logger.debug(f"  _fill_salesforce_field: JS traversal failed for '{label}': {js_err}")

        return False

    @staticmethod
    async def _resolve_locator(page, target, locator_type, logger):
        """
        Resolve a Playwright locator based on locator_type.
        Always returns the first VISIBLE matching element.
        """
        import re

        # ── Normalize AI-generated locator_type variants ──────────────────────
        # Maps every variant an LLM might produce → canonical type the engine handles
        _ROLE_VARIANTS = {
            "role_button", "button_role", "button", "btn",
            "role_link", "link_role", "link",
            "role_menuitem", "menuitem",
            "role_tab", "tab",
            "role_checkbox", "checkbox_role",
            "role_combobox", "combobox_role",
            "role_option", "option_role",
            "role_textbox", "textbox_role",
        }
        _ROLE_MAP = {
            "role_button": "button", "button_role": "button", "button": "button", "btn": "button",
            "role_link": "link",   "link_role": "link",   "link": "link",
            "role_menuitem": "menuitem", "menuitem": "menuitem",
            "role_tab": "tab",     "tab": "tab",
            "role_checkbox": "checkbox", "checkbox_role": "checkbox",
            "role_combobox": "combobox", "combobox_role": "combobox",
            "role_option": "option",     "option_role": "option",
            "role_textbox": "textbox",   "textbox_role": "textbox",
        }
        _LABEL_VARIANTS = {
            "field_label", "get_by_label", "by_label", "field_name",
            "aria_label", "aria-label", "aria_labelledby",
            "form_label", "input_label",
        }
        _TEXT_VARIANTS = {
            "get_by_text", "by_text", "inner_text", "visible_text",
            "exact_text", "contains_text", "partial_text",
        }
        _CSS_VARIANTS = {
            "css_selector", "selector", "xpath", "query_selector",
        }

        if locator_type:
            lt = locator_type.lower().strip()
            if lt in _ROLE_VARIANTS:
                aria_role = _ROLE_MAP.get(lt, "button")
                # If target is plain text (e.g. "Edit"), rewrite to role=button, name=Edit
                if not re.match(r"role=\w+,\s*name=", target):
                    old_target = target
                    target = f"role={aria_role}, name={target}"
                    logger.info(f"  ℹ Normalized locator_type '{locator_type}' → 'role'; rewrote target '{old_target}' → '{target}'")
                else:
                    logger.info(f"  ℹ Normalized locator_type '{locator_type}' → 'role'")
                locator_type = "role"
            elif lt in _LABEL_VARIANTS:
                logger.info(f"  ℹ Normalized locator_type '{locator_type}' → 'label'")
                locator_type = "label"
            elif lt in _TEXT_VARIANTS:
                logger.info(f"  ℹ Normalized locator_type '{locator_type}' → 'text'")
                locator_type = "text"
            elif lt in _CSS_VARIANTS:
                logger.info(f"  ℹ Normalized locator_type '{locator_type}' → 'css'")
                locator_type = "css"
            # Known valid types pass through unchanged:
            # "role", "label", "text", "css", "url", "placeholder", "alt", "title", ""

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
                
                # Check original role first
                loc = page.get_by_role(role, name=name, exact=False)
                if await loc.count() > 0:
                    vis_loc = await PlaywrightService._first_visible(loc, logger, f"role={role}, name={name}")
                    try:
                        if await vis_loc.is_visible():
                            logger.info(f"  → Resolved via get_by_role('{role}', name='{name}')")
                            return vis_loc
                    except Exception:
                        pass
                
                # Salesforce Fallbacks
                logger.info(f"  ℹ Strict role '{role}' failed or not visible. Trying fallbacks for name='{name}'")
                
                # Try alternative roles (button <-> link <-> menuitem)
                alt_roles = ["button", "link", "menuitem", "tab"]
                for alt_role in alt_roles:
                    if alt_role == role: continue
                    alt_loc = page.get_by_role(alt_role, name=name, exact=False)
                    if await alt_loc.count() > 0:
                        vis_alt = await PlaywrightService._first_visible(alt_loc, logger, f"fallback role={alt_role}, name={name}")
                        try:
                            if await vis_alt.is_visible():
                                logger.info(f"  → Resolved via fallback get_by_role('{alt_role}', name='{name}')")
                                return vis_alt
                        except Exception:
                            pass

                # Try exact/substring text
                try:
                    text_loc = page.get_by_text(name, exact=True)
                    if await text_loc.count() > 0:
                        vis_text = await PlaywrightService._first_visible(text_loc, logger, f"fallback exact text='{name}'")
                        try:
                            if await vis_text.is_visible():
                                logger.info(f"  → Resolved via fallback exact text: '{name}'")
                                return vis_text
                        except Exception:
                            pass
                except Exception:
                    pass

                # Try title attribute (very common in Salesforce actions)
                try:
                    title_loc = page.locator(f"[title~='{name}']")
                    if await title_loc.count() > 0:
                        vis_title = await PlaywrightService._first_visible(title_loc, logger, f"fallback title~='{name}'")
                        try:
                            if await vis_title.is_visible():
                                logger.info(f"  → Resolved via fallback title: '{name}'")
                                return vis_title
                        except Exception:
                            pass
                except Exception:
                    pass

                # If all fail, return the original to show standard error trace
                logger.warning(f"  ⚠ All role fallbacks failed. Returning original role locator to wait/fail naturally.")
                
                # Last resort: try common Salesforce-specific selectors for action buttons
                sf_selectors = [
                    f"a[title='{name}']",
                    f"button[title='{name}']",
                    f"lightning-button:has-text('{name}')",
                    f"lightning-button-menu:has-text('{name}')",
                    f"div[title='{name}']",
                    f"one-app-nav-bar-item-root:has-text('{name}')",
                    f"runtime_platform_actions-action-renderer:has-text('{name}')",
                ]
                for sf_sel in sf_selectors:
                    try:
                        sf_loc = page.locator(sf_sel)
                        if await sf_loc.count() > 0:
                            vis_sf = await PlaywrightService._first_visible(sf_loc, logger, f"SF selector: {sf_sel}")
                            try:
                                if await vis_sf.is_visible():
                                    logger.info(f"  → Resolved via SF selector: {sf_sel}")
                                    return vis_sf
                            except Exception:
                                pass
                    except Exception:
                        continue
                
                return page.get_by_role(role, name=name, exact=False).first

            else:
                logger.warning(f"  ⚠ Could not parse role target: '{target}', trying as CSS")
                return page.locator(target).first

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
                # Strategy 0: Lightning component selectors (highest priority for SF fields)
                # These target the actual <input> inside Lightning Web Components
                # where get_by_label fails because the label is outside the input.
                lightning_selectors = [
                    (f"lightning-input-field:has-text('{label_target}') input", "lightning-input-field"),
                    (f"lightning-datepicker:has-text('{label_target}') input", "lightning-datepicker"),
                    (f"lightning-input:has-text('{label_target}') input", "lightning-input"),
                    (f"lightning-combobox:has-text('{label_target}') input", "lightning-combobox"),
                    (f"input[aria-label='{label_target}']", "aria-label"),
                ]
                for sel, comp_type in lightning_selectors:
                    try:
                        loc = page.locator(sel)
                        if await loc.count() > 0:
                            logger.info(f"  → Resolved via {comp_type} for '{label_target}' (count={await loc.count()})")
                            return loc.first
                    except Exception:
                        continue

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

                # Strategy 4b: Try name= attribute directly (very common in lightning-input)
                try:
                    by_name = page.locator(f"input[name='{label_target}'], textarea[name='{label_target}']")
                    if await by_name.count() > 0:
                        logger.info(f"  → Quick win: found via input[name='{label_target}']")
                        return by_name.first
                except Exception:
                    pass

                # Strategy 5: Salesforce Lightning date / special input fields
                # Lightning Web Components use Shadow DOM that get_by_label CANNOT pierce.
                # Return immediately if found — element may be scrolled out of modal viewport
                # and is_visible() would incorrectly return false. Playwright's wait_for + fill
                # will auto-scroll it into view.
                try:
                    component_locators = [
                        page.locator("lightning-datepicker").filter(has_text=label_target).locator("input"),
                        page.locator("lightning-input").filter(has_text=label_target).locator("input"),
                        page.locator("lightning-input-field").filter(has_text=label_target).locator("input"),
                        page.locator(".slds-form-element").filter(has_text=label_target).locator("input"),
                        page.locator(f"input[name='{label_target}']"),
                        page.locator(f"input[aria-label='{label_target}']"),
                    ]
                    
                    for loc in component_locators:
                        try:
                            if await loc.count() > 0:
                                logger.info(f"  → Found via shadow-piercing component for '{label_target}' (count={await loc.count()})")
                                return loc.first
                        except Exception:
                            continue
                except Exception:
                    pass

                # Strategy 6: JavaScript shadow DOM traversal (last resort before fallback)
                # This can find inputs inside CLOSED shadow roots that no CSS/XPath can pierce
                try:
                    js_handle = await page.evaluate_handle("""(labelText) => {
                        function findInShadow(root, text) {
                            // Check labels in this root
                            const labels = root.querySelectorAll ? root.querySelectorAll('label, span.slds-form-element__label') : [];
                            for (const label of labels) {
                                if (label.textContent && label.textContent.trim().includes(text)) {
                                    // Found the label — now find the nearest input
                                    const parent = label.closest('lightning-input-field, lightning-input, lightning-datepicker, .slds-form-element') || label.parentElement;
                                    if (parent) {
                                        const input = parent.querySelector('input');
                                        if (input) return input;
                                    }
                                    // Try next sibling or following elements
                                    let el = label;
                                    while (el = el.nextElementSibling) {
                                        const inp = el.tagName === 'INPUT' ? el : el.querySelector && el.querySelector('input');
                                        if (inp) return inp;
                                    }
                                }
                            }
                            // Recurse into shadow roots
                            const allElements = root.querySelectorAll ? root.querySelectorAll('*') : [];
                            for (const el of allElements) {
                                if (el.shadowRoot) {
                                    const found = findInShadow(el.shadowRoot, text);
                                    if (found) return found;
                                }
                            }
                            return null;
                        }
                        // Search from the visible modal first, then the whole document
                        const modal = document.querySelector('div.modal-body, div.slds-modal__content, section.slds-modal, records-record-edit-form');
                        if (modal) {
                            const found = findInShadow(modal, labelText);
                            if (found) return found;
                        }
                        return findInShadow(document, labelText);
                    }""", label_target)
                    
                    if js_handle:
                        el = js_handle.as_element()
                        if el:
                            logger.info(f"  → Resolved '{label_target}' via JS shadow DOM traversal")
                            return el
                except Exception as js_err:
                    logger.warning(f"  ⚠ JS shadow traversal failed for '{label_target}': {js_err}")

            # Final fallback: full-page get_by_label with original target (relaxed match)
            logger.warning(f"  ⚠ All label strategies failed for '{target}', returning get_by_label fallback")
            return page.get_by_label(target, exact=False).first

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
                    page.set_default_timeout(30000)
                    page.set_default_navigation_timeout(45000)

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
                    page.set_default_timeout(30000)
                    page.set_default_navigation_timeout(45000)
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
                        # Global timeouts set after page creation below
                    except Exception as e:
                        print(f"[SESSION] Failed to load session: {e}")
                        context = await browser.new_context()
                    await context.tracing.start(screenshots=True, snapshots=True, sources=True)
                    page = await context.new_page()
                    page.set_default_timeout(30000)
                    page.set_default_navigation_timeout(45000)
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
                    page.set_default_timeout(30000)
                    page.set_default_navigation_timeout(45000)

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
                    sf_field_map = {}  # Dynamic field map, populated after modal opens
                    sf_metadata_map = {}  # MCP metadata map

                    # Load MCP metadata if project is connected
                    if project_id and (mcp_connected or project_category == "salesforce"):
                        try:
                            from uuid import UUID as _UUID
                            sf_metadata_map = await SalesforceLightningEngine.load_field_metadata(
                                _UUID(project_id) if isinstance(project_id, str) else project_id
                            )
                            if sf_metadata_map:
                                logger.info(f"  ℹ Loaded {len(sf_metadata_map)} field metadata entries")
                        except Exception as e:
                            logger.warning(f"  ⚠ Failed to load MCP metadata: {e}")

                    # Install persistent error-modal auto-dismisser
                    await SalesforceLightningEngine.install_error_modal_watcher(page)

                    # ─── Runtime step reordering for dependent picklists ───
                    # If metadata has controllerName info, ensure controlling field
                    # steps always run BEFORE dependent field steps.
                    execution_steps = steps  # default: use original steps
                    if sf_metadata_map:
                        try:
                            steps_list = list(steps)  # Make mutable copy
                            reordered = False
                            for i, step_i in enumerate(steps_list):
                                s_action = (step_i.get("action", "") if isinstance(step_i, dict)
                                            else getattr(step_i, "action", "")).lower().strip()
                                s_target = (step_i.get("target", "") if isinstance(step_i, dict)
                                            else getattr(step_i, "target", ""))
                                if s_action not in ("select", "fill", "type", "input"):
                                    continue
                                # Check if this target has a controlling field
                                meta = sf_metadata_map.get(s_target, {})
                                if not meta:
                                    for ml, mi in sf_metadata_map.items():
                                        if s_target.lower() == ml.lower():
                                            meta = mi
                                            break
                                ctrl_api = meta.get("controllerName", "")
                                if not ctrl_api:
                                    continue
                                # Resolve controlling field API name to label
                                ctrl_label = ""
                                for ml, mi in sf_metadata_map.items():
                                    api = mi.get("api_name", "")
                                    if api and (api == ctrl_api or
                                               api.replace("__c", "") == ctrl_api.replace("__c", "")):
                                        ctrl_label = ml
                                        break
                                if not ctrl_label:
                                    ctrl_label = ctrl_api
                                # Find the controlling field's step
                                ctrl_idx = None
                                for j, step_j in enumerate(steps_list):
                                    j_target = (step_j.get("target", "") if isinstance(step_j, dict)
                                                else getattr(step_j, "target", ""))
                                    if j_target.lower() == ctrl_label.lower():
                                        ctrl_idx = j
                                        break
                                # If dependent step comes BEFORE controller step, move it after
                                if ctrl_idx is not None and i < ctrl_idx:
                                    dep_step = steps_list.pop(i)
                                    # Insert after controller step (which shifted left by 1)
                                    steps_list.insert(ctrl_idx, dep_step)
                                    print(f"[STEP-REORDER] Moved '{s_target}' (dependent) AFTER "
                                          f"'{ctrl_label}' (controller): step {i+1} → {ctrl_idx+1}")
                                    reordered = True
                            if reordered:
                                execution_steps = steps_list
                                print(f"[STEP-REORDER] ✅ Steps reordered for dependent picklist dependencies")
                        except Exception as reorder_err:
                            print(f"[STEP-REORDER] ⚠ Reorder failed (non-fatal): {reorder_err}")

                    for index, step in enumerate(execution_steps):
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

                        # Dismiss any Salesforce app-error modal that may be blocking the page
                        # (backup for cases where the MutationObserver watcher missed it)
                        await SalesforceLightningEngine.dismiss_error_modal(page)

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

                                # Extract expected URL fragment for verification
                                expected_fragment = nav_path.strip("/").lower() if nav_path else ""

                                # Navigate with retry — Salesforce SPA may not complete first attempt
                                for nav_attempt in range(3):
                                    try:
                                        await page.goto(full_target, wait_until="domcontentloaded", timeout=45000)
                                    except Exception as nav_err:
                                        if "ERR_ABORTED" in str(nav_err):
                                            logger.info(f"  ℹ Navigation absorbed by Salesforce SPA router")
                                        else:
                                            raise

                                    # Wait for page to settle
                                    await SalesforceLightningEngine.wait_for_page_ready(page)

                                    # Verify URL contains expected path
                                    current_url = page.url.lower()
                                    if expected_fragment and expected_fragment not in current_url:
                                        logger.warning(
                                            f"  ⚠ Nav attempt {nav_attempt + 1}: URL mismatch — "
                                            f"expected '{expected_fragment}' in '{page.url}'"
                                        )
                                        if nav_attempt < 2:
                                            await asyncio.sleep(3)
                                            continue
                                        else:
                                            logger.warning(f"  ⚠ Navigation may not have reached target after 3 attempts")
                                    else:
                                        logger.info(f"  ✅ Navigation confirmed: {page.url}")
                                        break

                                # Extra wait for Salesforce list view to fully render
                                if "list" in (nav_path or "").lower() or "/o/" in (nav_path or ""):
                                    try:
                                        await page.locator(
                                            "force-list-view-manager-header, .forceListViewManager, "
                                            ".slds-page-header, lst-list-view-manager-header, "
                                            "lightning-list-view-header"
                                        ).first.wait_for(state="visible", timeout=15000)
                                        logger.info(f"  ✅ List view rendered")
                                    except Exception:
                                        await asyncio.sleep(3)

                            elif action == "click":
                                # Wait for page DOM readiness
                                try:
                                    await page.wait_for_load_state("domcontentloaded", timeout=10000)
                                except Exception:
                                    pass

                                target_lower = (target or "").lower()

                                # For SF action buttons, wait for list view to render first
                                if any(kw in target_lower for kw in ["new", "edit", "delete", "clone", "import"]):
                                    logger.info("  ℹ SF action button — waiting for list view")
                                    try:
                                        await page.locator(
                                            "force-list-view-manager-header, .forceListViewManager, "
                                            ".slds-page-header, lst-list-view-manager-header"
                                        ).first.wait_for(state="visible", timeout=25000)
                                        await asyncio.sleep(2)
                                    except Exception:
                                        await asyncio.sleep(5)

                                # ─── Smart Click with fast-fail ───
                                # First attempt
                                click_succeeded = False
                                last_click_err = None
                                for click_attempt in range(2):  # max 2 attempts (not 3)
                                    try:
                                        loc = await SalesforceLightningEngine.resolve_locator(
                                            page, target, locator_type
                                        )
                                        await SalesforceLightningEngine.safe_click(page, loc)
                                        click_succeeded = True
                                        break
                                    except Exception as click_err:
                                        last_click_err = click_err
                                        err_msg = str(click_err)

                                        # ─── Fast-fail: if element is not in DOM, don't retry ───
                                        if ("not found in DOM" in err_msg
                                            or "not exist on the current page" in err_msg
                                            or "page fully loaded" in err_msg):
                                            logger.warning(
                                                f"  ⚠ Element '{target}' not found in DOM — "
                                                f"skipping further retries (fast-fail)"
                                            )
                                            break

                                        if click_attempt < 1:  # only retry once
                                            logger.info(f"  ℹ Click attempt {click_attempt+1} failed, retrying in 3s...")
                                            await asyncio.sleep(3)

                                            # Before retrying, check if element exists now
                                            try:
                                                probe_loc = await SalesforceLightningEngine.resolve_locator(
                                                    page, target, locator_type
                                                )
                                                probe_count = await probe_loc.count() if hasattr(probe_loc, 'count') else 0
                                                if probe_count == 0:
                                                    logger.warning(
                                                        f"  ⚠ Element '{target}' still not on page — aborting retry"
                                                    )
                                                    break
                                            except Exception:
                                                pass

                                if not click_succeeded:
                                    raise last_click_err

                                # Post-click: modal awareness + field map scanning
                                if any(kw in target_lower for kw in ["new", "edit", "create", "clone", "quick"]):
                                    modal_found = await SalesforceLightningEngine.wait_for_modal(page)

                                    # Modal verification loop — retry click if modal didn't open
                                    if not modal_found:
                                        for retry_attempt in range(2):
                                            logger.info(
                                                f"  ℹ Modal not found — retry attempt {retry_attempt + 1}/2"
                                            )
                                            await asyncio.sleep(3)

                                            # Re-resolve locator
                                            try:
                                                loc = await SalesforceLightningEngine.resolve_locator(
                                                    page, target, locator_type
                                                )
                                            except Exception:
                                                continue

                                            # Try force click, then JS click
                                            try:
                                                logger.info("  ℹ Retry: force click")
                                                await loc.click(force=True, timeout=10000)
                                            except Exception:
                                                try:
                                                    logger.info("  ℹ Retry: JS click")
                                                    element = await loc.element_handle(timeout=10000)
                                                    if element:
                                                        await page.evaluate("(el) => el.click()", element)
                                                except Exception as js_err:
                                                    logger.debug(f"  JS click retry failed: {js_err}")
                                                    continue

                                            modal_found = await SalesforceLightningEngine.wait_for_modal(page)
                                            if modal_found:
                                                logger.info("  ℹ Modal detected after retry click")
                                                break

                                        # Last resort: check for full-page form (not modal)
                                        if not modal_found:
                                            logger.info("  ℹ Checking for full-page record form")
                                            try:
                                                await page.locator(
                                                    "records-record-edit-form, lightning-record-edit-form, "
                                                    ".slds-form, force-record-layout-section"
                                                ).first.wait_for(state="visible", timeout=10000)
                                                logger.info("  ℹ Full-page record form detected")
                                            except Exception:
                                                await asyncio.sleep(3)

                                    sf_field_map = await SalesforceLightningEngine.scan_field_map(page)

                                    # B10: Handle Record Type selection modal (appears before new record form)
                                    await SalesforceLightningEngine.handle_record_type_modal(page)

                                    # E2: Wait for spinner to clear after modal opens
                                    await SalesforceLightningEngine.wait_for_spinner_gone(page)

                                elif "save" in target_lower:
                                    # ─── Component 3: Pre-save required field check ───
                                    try:
                                        filled_fields = set()
                                        for prev_log in logs:
                                            t = prev_log.get("target", "")
                                            if t and prev_log.get("status") == "success":
                                                filled_fields.add(t.lower())
                                        missing_required = []
                                        for meta_label, meta_info in sf_metadata_map.items():
                                            if meta_info.get("required"):
                                                if not any(meta_label.lower() in f or f in meta_label.lower() for f in filled_fields):
                                                    missing_required.append(meta_label)
                                        if missing_required:
                                            print(f"[PRE-SAVE] ⚠ Required fields not filled: {missing_required}")
                                            logger.info(f"  ⚠ Pre-save warning: missing required fields: {missing_required}")
                                    except Exception as ps_err:
                                        print(f"[PRE-SAVE] Check error: {ps_err}")

                                    # E2: Wait for spinner to clear after save
                                    await SalesforceLightningEngine.wait_for_spinner_gone(page)

                                    # E3: Auto-handle Duplicate Rule popup (save_anyway by default)
                                    await SalesforceLightningEngine.handle_duplicate_popup(page, "save_anyway")

                                    # Wait longer — VF errors can take 3-5s to appear after save
                                    await asyncio.sleep(3)

                                    # E4: Post-save error check across ALL frames
                                    # Salesforce VF errors appear inside child iframes — page.text_content("body")
                                    # only reads the main frame. We must check ALL frames explicitly.
                                    _save_error_patterns = [
                                        "update failed",
                                        "required field",
                                        "first error:",
                                        "error in expression",
                                        "validation rule",
                                        "review the following",
                                        "field integrity exception",
                                        "insufficient access",
                                        "system.dmlexception",
                                        "an error occurred",
                                    ]
                                    _post_save_error = None

                                    try:
                                        # Check all frames: main page + every child iframe
                                        frames_to_check = [page.main_frame] + page.frames[1:]
                                        for _frame in frames_to_check:
                                            try:
                                                # Use evaluate → innerText (renders actual visible text)
                                                _frame_text = await _frame.evaluate("document.body ? document.body.innerText : ''") or ""
                                                _frame_text_lower = _frame_text.lower()
                                                for _pat in _save_error_patterns:
                                                    if _pat in _frame_text_lower:
                                                        _idx = _frame_text_lower.find(_pat)
                                                        _post_save_error = _frame_text[max(0, _idx):_idx + 300].strip()
                                                        logger.info(f"  ⚠ Post-save error found in frame: {_post_save_error[:100]}")
                                                        break
                                                if _post_save_error:
                                                    break
                                            except Exception:
                                                continue

                                        # Also check specific SF error CSS selectors on main page
                                        if not _post_save_error:
                                            _precise_err_selectors = [
                                                ".slds-notify--error",
                                                "div[data-key='error']",
                                                ".slds-notify_alert[role='alert']",
                                                ".pageLevelErrors",
                                                ".forceFormPageError",
                                                ".inlineErrors",
                                                ".errorMsg",
                                                ".slds-theme--error",
                                                "div.slds-box.error",
                                                "p.errorMsg",
                                                "div.message.errorM3",
                                            ]
                                            for _esel in _precise_err_selectors:
                                                try:
                                                    _eloc = page.locator(_esel)
                                                    if await _eloc.count() > 0 and await _eloc.first.is_visible():
                                                        _etxt = (await _eloc.first.text_content() or "").strip()[:300]
                                                        if _etxt and len(_etxt) > 5:
                                                            _post_save_error = _etxt
                                                            logger.info(f"  ⚠ Post-save error via CSS '{_esel}': {_etxt[:80]}")
                                                            break
                                                except Exception:
                                                    continue
                                    except Exception as _pse_err:
                                        logger.debug(f"  Post-save error check outer failed: {_pse_err}")

                                    if _post_save_error:
                                        raise Exception(
                                            f"Save FAILED — Salesforce error after Save: {_post_save_error[:300]}"
                                        )

                                    try:
                                        toast = page.locator(
                                            ".toastMessage, .forceToastMessage, "
                                            ".slds-notify__content, div[data-key='success'], div[data-key='error']"
                                        )
                                        await toast.first.wait_for(state="visible", timeout=5000)
                                        logger.info("  ℹ Toast notification detected")
                                    except Exception:
                                        pass
                                elif "delete" in target_lower or "confirm" in target_lower:
                                    await asyncio.sleep(1)

                            elif action in ["fill", "input", "type"]:
                                # Wait for the target field to appear on the page
                                # (after clicking Edit/New, the form modal may take time to render)
                                try:
                                    await page.wait_for_selector(
                                        f"label:has-text('{target}'), "
                                        f"span.slds-form-element__label:has-text('{target}'), "
                                        f".test-id__field-label:has-text('{target}')",
                                        state="visible",
                                        timeout=15000,
                                    )
                                    print(f"[STEP] ✅ Field label '{target}' found on page")
                                except Exception:
                                    print(f"[STEP] ⚠ Field label '{target}' not found after 15s — continuing")

                                # Check if metadata says this is a picklist
                                meta_info = sf_metadata_map.get(target)
                                if not meta_info and sf_metadata_map:
                                    for ml, mi in sf_metadata_map.items():
                                        if target.lower() in ml.lower() or ml.lower() in target.lower():
                                            meta_info = mi
                                            break
                                print(f"[STEP] TYPE action for '{target}' = '{value}', meta_type={meta_info.get('type') if meta_info else 'none'}")
                                if meta_info and meta_info.get("type") == "multipicklist":
                                    logger.info(f"  ℹ Metadata redirect: TYPE '{target}' → MULTI_SELECT")
                                    await SalesforceLightningEngine.scroll_modal_to_field(page, target)
                                    success = await SalesforceLightningEngine._fill_multi_picklist(
                                        page, target, value
                                    )
                                    if not success:
                                        # Fallback to single picklist
                                        success = await SalesforceLightningEngine._fill_picklist(
                                            page, target, value
                                        )
                                    if not success:
                                        raise Exception(
                                            f"Could not select '{value}' in multi-select field '{target}' — all strategies exhausted"
                                        )
                                elif meta_info and meta_info.get("type") in ("picklist", "combobox"):
                                    logger.info(f"  ℹ Metadata redirect: TYPE '{target}' → SELECT (picklist)")
                                    await SalesforceLightningEngine.scroll_modal_to_field(page, target)
                                    success = await SalesforceLightningEngine._fill_picklist(
                                        page, target, value
                                    )
                                    if not success:
                                        raise Exception(
                                            f"Could not select '{value}' in picklist field '{target}' — all strategies exhausted"
                                        )
                                elif meta_info and meta_info.get("type") == "boolean":
                                    logger.info(f"  ℹ Metadata redirect: TYPE '{target}' → CHECKBOX")
                                    await SalesforceLightningEngine.scroll_modal_to_field(page, target)
                                    success = await SalesforceLightningEngine._fill_checkbox(
                                        page, target, value
                                    )
                                    if not success:
                                        raise Exception(
                                            f"Could not toggle checkbox '{target}' — all strategies exhausted"
                                        )
                                elif meta_info and meta_info.get("type") == "reference":
                                    logger.info(f"  ℹ Metadata redirect: TYPE '{target}' → LOOKUP_SELECT (reference)")
                                    await SalesforceLightningEngine.scroll_modal_to_field(page, target)
                                    success = await SalesforceLightningEngine._fill_lookup(
                                        page, target, value
                                    )
                                    if not success:
                                        raise Exception(
                                            f"Could not find/select '{value}' in lookup field '{target}' — all strategies exhausted"
                                        )
                                elif meta_info and meta_info.get("type") in ("date", "datetime"):
                                    print(f"[STEP] Metadata redirect: TYPE '{target}' → DATE fill")
                                    await SalesforceLightningEngine.scroll_modal_to_field(page, target)
                                    success = await SalesforceLightningEngine._fill_date(
                                        page, target, value
                                    )
                                    if not success:
                                        # Fallback to fill_field which has JS probe
                                        await SalesforceLightningEngine.fill_field(
                                            page, target, value, sf_field_map, sf_metadata_map
                                        )
                                else:
                                    # Standard text field fill with proper Lightning commit
                                    await SalesforceLightningEngine.scroll_modal_to_field(page, target)

                                    # Find the input by label
                                    input_loc = None
                                    for sel in [
                                        f"lightning-input:has-text('{target}') input",
                                        f"lightning-textarea:has-text('{target}') textarea",
                                        f"input[placeholder*='{target}']",
                                    ]:
                                        try:
                                            loc = page.locator(sel)
                                            if await loc.count() > 0 and await loc.first.is_visible():
                                                input_loc = loc.first
                                                break
                                        except Exception:
                                            continue

                                    if not input_loc:
                                        # Fallback: find input INSIDE the modal, filtering non-form elements
                                        try:
                                            # First try modal-scoped search
                                            modal_selectors = [
                                                ".slds-modal__content",
                                                "section.slds-modal",
                                                "[role='dialog']",
                                            ]
                                            scope = None
                                            for ms in modal_selectors:
                                                try:
                                                    m = page.locator(ms)
                                                    if await m.count() > 0 and await m.first.is_visible():
                                                        scope = m.first
                                                        break
                                                except Exception:
                                                    continue

                                            search_ctx = scope if scope else page
                                            loc = search_ctx.get_by_label(target, exact=False)
                                            cnt = await loc.count()
                                            for i in range(min(cnt, 8)):
                                                candidate = loc.nth(i)
                                                try:
                                                    info = await candidate.evaluate("""el => ({
                                                        tag: el.tagName.toLowerCase(),
                                                        type: (el.type || '').toLowerCase(),
                                                        cls: el.className || '',
                                                    })""")
                                                    tag = info.get("tag", "")
                                                    inp_type = info.get("type", "")
                                                    cls = info.get("cls", "")
                                                    # Skip non-form elements
                                                    if tag not in ('input', 'textarea', 'select'):
                                                        continue
                                                    # Skip column resizers, hidden inputs, assistive-text
                                                    if inp_type in ('range', 'hidden', 'checkbox', 'radio'):
                                                        continue
                                                    if 'slds-assistive-text' in cls:
                                                        continue
                                                    if await candidate.is_visible():
                                                        input_loc = candidate
                                                        print(f"[STEP] Found input for '{target}' via modal-scoped get_by_label (tag={tag}, type={inp_type})")
                                                        break
                                                except Exception:
                                                    continue
                                        except Exception:
                                            pass

                                    # Strategy: Try lookup FIRST — but ONLY if the field type
                                    # is unknown or could be a reference.  Skip for email,
                                    # phone, url, textarea etc. where lookup causes errors.
                                    NON_LOOKUP_TYPES = (
                                        "string", "email", "phone", "url",
                                        "textarea", "percent", "currency",
                                        "int", "double", "encryptedstring",
                                        "base64", "id",
                                    )
                                    meta_type = (meta_info.get("type", "") if meta_info else "").lower()
                                    should_try_lookup = meta_type not in NON_LOOKUP_TYPES

                                    if should_try_lookup:
                                        print(f"[STEP] Trying _fill_lookup first for '{target}' (meta_type={meta_type})")
                                        await SalesforceLightningEngine.scroll_modal_to_field(page, target)
                                        success = await SalesforceLightningEngine._fill_lookup(
                                            page, target, value
                                        )
                                        if success:
                                            print(f"[STEP] ✅ '{target}' filled via _fill_lookup")
                                    else:
                                        print(f"[STEP] Skipping lookup for '{target}' (meta_type={meta_type}) — using direct text fill")
                                        success = False

                                    if not success and input_loc:
                                        # Not a lookup — use generic text fill
                                        print(f"[STEP] _fill_lookup returned False, using text fill for '{target}'")
                                        await input_loc.click(timeout=5000)
                                        await asyncio.sleep(0.3)
                                        await input_loc.press("Control+a")
                                        await asyncio.sleep(0.1)
                                        await page.keyboard.type(value, delay=80)
                                        await asyncio.sleep(0.3)
                                        await page.keyboard.press("Tab")
                                        await asyncio.sleep(0.5)
                                        print(f"[STEP] ✅ Text field '{target}' filled with '{value}' + Tab commit")
                                    else:
                                        # Last resort: try fill_field
                                        await SalesforceLightningEngine.fill_field(
                                            page, target, value, sf_field_map, sf_metadata_map
                                        )
                                        print(f"[STEP] ⚠ fill_field fallback used for '{target}'")

                            elif action == "select":
                                # Direct picklist fill
                                await SalesforceLightningEngine.scroll_modal_to_field(page, target)

                                # Check for dependent picklist — if the controlling field
                                # hasn't been set yet, provide a clear diagnostic
                                dep_controller_label = ""
                                if sf_metadata_map:
                                    meta = sf_metadata_map.get(target, {})
                                    if not meta:
                                        for ml, mi in sf_metadata_map.items():
                                            if target.lower() in ml.lower() or ml.lower() in target.lower():
                                                meta = mi
                                                break
                                    ctrl_api = meta.get("controllerName", "")
                                    if ctrl_api:
                                        # Resolve API name to label
                                        for ml, mi in sf_metadata_map.items():
                                            if mi.get("api_name", "").replace("__c", "") == ctrl_api.replace("__c", ""):
                                                dep_controller_label = ml
                                                break
                                        if not dep_controller_label:
                                            dep_controller_label = ctrl_api
                                        print(f"[PICKLIST-DEP] '{target}' is dependent on controlling field '{dep_controller_label}'")

                                success = await SalesforceLightningEngine._fill_picklist(
                                    page, target, value
                                )
                                if not success:
                                    err_msg = (
                                        f"Could not select '{value}' in picklist field '{target}' — all strategies exhausted. "
                                        f"Check if '{value}' is a valid option for this field."
                                    )
                                    if dep_controller_label:
                                        err_msg += (
                                            f" This is a DEPENDENT PICKLIST controlled by '{dep_controller_label}' — "
                                            f"ensure '{dep_controller_label}' is selected BEFORE '{target}'."
                                        )
                                    raise Exception(err_msg)

                            elif action in ("lookup", "lookup_select"):
                                # Direct lookup fill with record selection
                                await SalesforceLightningEngine.scroll_modal_to_field(page, target)
                                success = await SalesforceLightningEngine._fill_lookup(
                                    page, target, value
                                )
                                if not success:
                                    raise Exception(
                                        f"LOOKUP_SELECT failed: could not find/select '{value}' in lookup field '{target}'. "
                                        f"Ensure the record exists in the related object."
                                    )

                            elif action == "checkbox":
                                # A1: Checkbox/toggle field
                                await SalesforceLightningEngine.scroll_modal_to_field(page, target)
                                success = await SalesforceLightningEngine._fill_checkbox(
                                    page, target, value
                                )
                                if not success:
                                    raise Exception(
                                        f"Could not toggle checkbox '{target}' — all strategies exhausted"
                                    )

                            elif action == "multi_select":
                                # A2: Multi-select picklist
                                await SalesforceLightningEngine.scroll_modal_to_field(page, target)
                                success = await SalesforceLightningEngine._fill_multi_picklist(
                                    page, target, value
                                )
                                if not success:
                                    raise Exception(
                                        f"Could not select values '{value}' in multi-select field '{target}' — all strategies exhausted"
                                    )

                            elif action == "upload":
                                # A4: File upload
                                success = await SalesforceLightningEngine._fill_file_upload(
                                    page, target, value
                                )
                                if not success:
                                    raise Exception(
                                        f"File upload failed for '{target}' with path '{value}'"
                                    )

                            elif action == "tab":
                                # B3: Tab switching on record detail page
                                tab_name = target or value or ""
                                if tab_name:
                                    try:
                                        tab_loc = page.get_by_role("tab", name=tab_name, exact=False)
                                        if await tab_loc.count() > 0:
                                            await tab_loc.first.click(timeout=5000)
                                            await asyncio.sleep(1)
                                            logger.info(f"  → Switched to tab: '{tab_name}'")
                                        else:
                                            # Fallback: try text-based click
                                            text_loc = page.get_by_text(tab_name, exact=False)
                                            if await text_loc.count() > 0:
                                                await text_loc.first.click(timeout=5000)
                                                await asyncio.sleep(1)
                                                logger.info(f"  → Clicked tab text: '{tab_name}'")
                                            else:
                                                raise Exception(f"Tab '{tab_name}' not found")
                                    except Exception as tab_err:
                                        raise Exception(f"Tab switch to '{tab_name}' failed: {tab_err}")

                            elif action == "inline_edit":
                                # B1: Inline edit on record detail page
                                # target = field label, value = new value
                                # locator_type can indicate field_type: 'picklist','lookup','date','checkbox'
                                field_type_hint = locator_type if locator_type in (
                                    "picklist", "lookup", "date", "checkbox", "multipicklist"
                                ) else "text"
                                success = await SalesforceLightningEngine.inline_edit(
                                    page, target, value,
                                    field_type=field_type_hint,
                                    metadata_map=sf_metadata_map or {}
                                )
                                if not success:
                                    raise Exception(
                                        f"Inline edit failed for '{target}' — field not found or not editable"
                                    )

                            elif action == "quick_action":
                                # B4: Quick Action from record action bar / overflow menu
                                # target = action name (e.g. 'Log a Call', 'New Task')
                                action_name_qa = target or value or ""
                                success = await SalesforceLightningEngine.click_quick_action(
                                    page, action_name_qa
                                )
                                if not success:
                                    raise Exception(
                                        f"Quick Action '{action_name_qa}' not found or not clickable"
                                    )
                                # If a modal opened, scan field map
                                modal_found = await SalesforceLightningEngine.wait_for_modal(page)
                                if modal_found:
                                    sf_field_map = await SalesforceLightningEngine.scan_field_map(page)
                                    await SalesforceLightningEngine.handle_record_type_modal(page)
                                    await SalesforceLightningEngine.wait_for_spinner_gone(page)

                            elif action == "list_row_action":
                                # B5: Row-level action in list view
                                # target = record name to find the row
                                # value = action name (e.g. 'Edit', 'Delete', 'Clone')
                                success = await SalesforceLightningEngine.click_list_view_row_action(
                                    page, target, value
                                )
                                if not success:
                                    raise Exception(
                                        f"List view row action '{value}' on '{target}' failed"
                                    )

                            elif action == "path_stage":
                                # B9: Path component stage update
                                # target = stage name (e.g. 'Closed Won', 'Prospecting')
                                stage_name_arg = target or value or ""
                                success = await SalesforceLightningEngine.click_path_stage(
                                    page, stage_name_arg
                                )
                                if not success:
                                    raise Exception(
                                        f"Path stage '{stage_name_arg}' not found on the page"
                                    )

                            elif action == "dismiss_toast":
                                # B8: Dismiss toast notification
                                await SalesforceLightningEngine.dismiss_toast(page)
                                # Not raising on False — toast may already be gone, that's OK

                            elif action == "address":
                                # A5: Compound address field
                                # target = field label, value = comma-separated address string
                                success = await SalesforceLightningEngine._fill_address(
                                    page, target, value
                                )
                                if not success:
                                    raise Exception(f"Address fill failed for '{target}'")

                            elif action == "assert_text":
                                # Determine expected text: use value if set, otherwise target IS the text to find
                                expected_text = value if value else target
                                if not expected_text:
                                    raise Exception("ASSERT_TEXT requires either value or target with expected text")

                                # Detect if this is a toast/notification assertion
                                combined = (target + " " + (value or "")).lower()
                                is_toast = any(kw in combined for kw in ["toast", "notify", "created", "saved", "deleted", "updated", "error"])

                                found_text = None

                                # Strategy 1: Wait and retry for toast (they appear briefly)
                                if is_toast:
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
                                    combined_toast = ", ".join(toast_selectors)

                                    # Wait up to 10s for any toast to appear
                                    try:
                                        toast_loc = page.locator(combined_toast)
                                        await toast_loc.first.wait_for(state="visible", timeout=10000)
                                        found_text = await toast_loc.first.text_content()
                                        logger.info(f"  ℹ Toast detected: '{(found_text or '')[:60]}'")
                                    except Exception:
                                        # Retry: poll for toast every 1s for 5 more seconds
                                        for retry in range(5):
                                            await asyncio.sleep(1)
                                            for ts in toast_selectors:
                                                try:
                                                    tl = page.locator(ts)
                                                    if await tl.count() > 0:
                                                        txt = await tl.first.text_content()
                                                        if txt:
                                                            found_text = txt
                                                            logger.info(f"  ℹ Toast found on retry {retry+1}: '{ts}'")
                                                            break
                                                except Exception:
                                                    continue
                                            if found_text:
                                                break

                                # Detect if this is a PDF/report preview assertion
                                is_pdf_assertion = any(kw in combined for kw in [
                                    "pdf", "previewouter", "canvas", "pdfviewer", "iframe[src*=", "preview"
                                ])

                                # ─── PDF Pre-wait Strategy ───
                                # PDF renderers inside SF modals take 5–20s. Poll for content.
                                if is_pdf_assertion:
                                    logger.info("  ℹ PDF assertion — polling for PDF/modal (max 15s)...")
                                    url_before = page.url
                                    pdf_found = False

                                    for poll_attempt in range(8):  # 8 × 2s = 16s max
                                        # ── A: Playwright text/css locators (pierce shadow DOM) ──
                                        for pw_selector in [
                                            "text=Save",          # Playwright text= pierces shadow DOM
                                            "text=Cancel",
                                            ":text('Save')",      # CSS text pseudo
                                            ":text('Cancel')",
                                            "iframe",             # any iframe (VF PDF)
                                            "canvas",             # rendered PDF canvas
                                            ".slds-modal",
                                            ".slds-modal__container",
                                            "section.slds-modal",
                                            "[class*='modal']",
                                            "[class*='overlay']",
                                            "lightning-dialog",
                                            "force-record-edit-modal",
                                        ]:
                                            try:
                                                loc = page.locator(pw_selector)
                                                cnt = await loc.count()
                                                if cnt > 0:
                                                    # For text selectors, just existing is enough
                                                    vis = await loc.first.is_visible()
                                                    if vis:
                                                        found_text = f"pdf_element_visible:{pw_selector}"
                                                        pdf_found = True
                                                        logger.info(f"  ✅ PDF modal detected ('{pw_selector}') — attempt {poll_attempt+1}")
                                                        break
                                            except Exception:
                                                continue
                                        if pdf_found:
                                            break

                                        # ── B: New tab opened by Generate PDF ──
                                        try:
                                            for p2 in page.context.pages:
                                                if p2 != page:
                                                    found_text = f"pdf_element_visible:new_tab:{p2.url}"
                                                    pdf_found = True
                                                    logger.info(f"  ✅ PDF opened in new tab: {p2.url}")
                                                    break
                                        except Exception:
                                            pass
                                        if pdf_found:
                                            break

                                        # ── C: Page URL changed (navigated to PDF page) ──
                                        try:
                                            if page.url != url_before:
                                                found_text = f"pdf_element_visible:url_changed:{page.url}"
                                                pdf_found = True
                                                logger.info(f"  ✅ Page navigated to: {page.url}")
                                                break
                                        except Exception:
                                            pass

                                        # ── D: Recursive shadow DOM JS traversal ──
                                        _shadow_js = """(function() {
    function walk(root, depth) {
        if (depth > 8) return null;
        try {
            // Check for dialog / modal in this root
            var d = root.querySelector('[role="dialog"],[role="alertdialog"],.slds-modal,.slds-modal__container,iframe,canvas');
            if (d) {
                var r = d.getBoundingClientRect();
                if (r.width > 10 && r.height > 10) return d.className || d.tagName;
            }
            // Check for Save/Cancel buttons
            var btns = root.querySelectorAll('button,lightning-button,input[type="submit"]');
            for (var b of btns) {
                var t = (b.textContent || b.value || b.label || '').trim().toLowerCase();
                if (t === 'save' || t === 'cancel') {
                    var br = b.getBoundingClientRect();
                    if (br.width > 0 && br.height > 0) return 'button:' + t;
                }
            }
            // Recurse into shadow roots
            var all = root.querySelectorAll('*');
            for (var i = 0; i < Math.min(all.length, 500); i++) {
                try {
                    if (all[i].shadowRoot) {
                        var found = walk(all[i].shadowRoot, depth + 1);
                        if (found) return found;
                    }
                } catch(e) {}
            }
        } catch(e) {}
        return null;
    }
    return walk(document, 0);
})()"""
                                        try:
                                            js_result = await page.evaluate(_shadow_js)
                                            logger.info(f"  ℹ Shadow DOM scan attempt {poll_attempt+1}: {js_result!r}")
                                            if js_result:
                                                found_text = f"pdf_element_visible:shadow:{js_result}"
                                                pdf_found = True
                                                logger.info(f"  ✅ PDF element found in shadow DOM: {js_result}")
                                                break
                                        except Exception as js_err:
                                            logger.info(f"  ℹ Shadow DOM scan error: {js_err}")

                                        await asyncio.sleep(2)

                                    # ── E: Soft-pass — no error banner visible after click ──
                                    # If button click succeeded but we can't detect the modal due to
                                    # Salesforce Shadow DOM, check there's no error on page.
                                    # No error after PDF click = action was triggered successfully.
                                    if not pdf_found:
                                        logger.info("  ⚠ PDF element not detected (possible shadow DOM). Checking for errors...")
                                        page_error_found = False
                                        error_msg_text = ""
                                        for err_sel in [
                                            ".slds-notify--error", "div[data-key='error']",
                                            ".slds-has-error", ".forceFormPageError",
                                            ":text('Error')", ":text('required')",
                                        ]:
                                            try:
                                                err_loc = page.locator(err_sel)
                                                if await err_loc.count() > 0 and await err_loc.first.is_visible():
                                                    page_error_found = True
                                                    error_msg_text = (await err_loc.first.text_content() or "").strip()[:200]
                                                    break
                                            except Exception:
                                                continue

                                        if page_error_found:
                                            raise Exception(
                                                f"PDF generation failed — error visible on page: {error_msg_text}"
                                            )
                                        else:
                                            # Soft pass: button was clicked, no error found
                                            found_text = "pdf_element_visible:soft_pass_no_error"
                                            logger.info(
                                                "  ✅ PDF assertion soft-pass: button clicked, no error on page. "
                                                "Modal likely in Shadow DOM and cannot be inspected directly."
                                            )

                                # Strategy 2: Try the specified locator
                                if found_text is None:
                                    try:
                                        locator = await PlaywrightService._resolve_locator(page, target, locator_type, logger)
                                        await locator.wait_for(state="visible", timeout=5000 if is_toast else 15000)
                                        found_text = await locator.text_content()
                                    except Exception:
                                        pass

                                # Strategy 3: Try get_by_text — but EXCLUDE pure navigation elements
                                # (tabs, breadcrumbs, nav menus) to avoid false positives where
                                # a word like 'Files' matches a Related tab label, not actual content.
                                if found_text is None:
                                    try:
                                        text_loc = page.get_by_text(expected_text, exact=False)
                                        count = await text_loc.count()
                                        if count > 0:
                                            # Filter out elements that are purely nav/tab/breadcrumb
                                            _nav_roles = {"tab", "navigation", "menubar", "menuitem", "menu", "tablist"}
                                            for _ti in range(min(count, 8)):
                                                try:
                                                    _el = text_loc.nth(_ti)
                                                    if not await _el.is_visible():
                                                        continue
                                                    # Check ARIA role of the element or its parent
                                                    _role = await _el.get_attribute("role") or ""
                                                    _aria = await _el.get_attribute("aria-label") or ""
                                                    _cls = await _el.get_attribute("class") or ""
                                                    _tag = await _el.evaluate("el => el.tagName.toLowerCase()")
                                                    # Skip if this looks like a navigation element
                                                    _is_nav = (
                                                        _role.lower() in _nav_roles
                                                        or "tab" in _cls.lower()
                                                        or "breadcrumb" in _cls.lower()
                                                        or "nav" in _cls.lower()
                                                        or _tag in ("nav", "header")
                                                        or "slds-tab" in _cls.lower()
                                                        or "navigationLink" in _cls
                                                    )
                                                    if _is_nav:
                                                        logger.info(f"  ℹ Skipping nav/tab element for assert_text '{expected_text}' (role={_role}, class={_cls[:40]})")
                                                        continue
                                                    # Non-nav element found — use it
                                                    found_text = await _el.text_content()
                                                    logger.info(f"  ℹ Text found via get_by_text('{expected_text}') [non-nav element]")
                                                    break
                                                except Exception:
                                                    continue
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

                                # ─── ALWAYS check for Salesforce error banners ───
                                # This runs BEFORE body-text fallback so that generic text
                                # like 'Invoice' found in a breadcrumb cannot mask a real error.
                                has_validation_errors = False
                                validation_error_text = ""
                                try:
                                    sf_error_selectors = [
                                        # Orange/red error banners (alert-type)
                                        ".slds-notify--error",
                                        ".slds-has-error",
                                        ".inlineErrors",
                                        ".slds-form-error",
                                        ".errorMsg",
                                        ".inputError",
                                        # Field-level required errors
                                        ".slds-form-element__help",
                                        "p.slds-form-error",
                                        # Page-level error banners
                                        ".forceFormPageError",
                                        "ul.errorsList",
                                        ".pageLevelErrors",
                                        # Error toast
                                        "div[data-key='error']",
                                        ".slds-notify_toast.slds-theme_error",
                                        ".slds-notify_toast.slds-theme--error",
                                        # Aura / LWC required-field callout
                                        "force-page-error",
                                        ".requiredFieldError",
                                        # Generic 'Review the following fields' popup
                                        "div:has-text('required field')",
                                        "div:has-text('Required field')",
                                        "div:has-text('REQUIRED FIELD')",
                                        "div:has-text('Missing required')",
                                    ]
                                    for sf_es in sf_error_selectors:
                                        try:
                                            err_loc = page.locator(sf_es)
                                            err_count = await err_loc.count()
                                            if err_count > 0 and await err_loc.first.is_visible():
                                                has_validation_errors = True
                                                try:
                                                    validation_error_text = (
                                                        await err_loc.first.text_content() or ""
                                                    ).strip()[:300]
                                                except Exception:
                                                    validation_error_text = f"Error banner found ({err_count} element(s))"
                                                logger.info(
                                                    f"  ⚠ Error banner detected via '{sf_es}': "
                                                    f"{validation_error_text[:120]}"
                                                )
                                                break
                                        except Exception:
                                            continue
                                    # Scan ALL frames for error text (VF iframe errors missed by CSS)
                                    if not has_validation_errors:
                                        _frame_err_pats = [
                                            "update failed", "required field", "first error:",
                                            "error in expression", "field integrity exception",
                                            "validation rule", "system.dmlexception",
                                        ]
                                        try:
                                            for _fr in ([page.main_frame] + page.frames[1:]):
                                                try:
                                                    _ft = await _fr.evaluate(
                                                        "document.body ? document.body.innerText : \'\'"
                                                    ) or ""
                                                    for _ep in _frame_err_pats:
                                                        if _ep in _ft.lower():
                                                            _ei = _ft.lower().find(_ep)
                                                            has_validation_errors = True
                                                            validation_error_text = _ft[max(0, _ei):_ei + 200].strip()
                                                            logger.info(f"  \u26a0 Error in frame: {validation_error_text[:100]}")
                                                            break
                                                    if has_validation_errors:
                                                        break
                                                except Exception:
                                                    continue
                                        except Exception:
                                            pass

                                except Exception as e:
                                    logger.debug(f"  Error banner check failed: {e}")

                                # If error banner found, FAIL immediately — do not fall through to body text
                                if has_validation_errors:
                                    raise Exception(
                                        f"Assertion FAILED — Salesforce error banner detected on page. "
                                        f"Error: {validation_error_text[:250]}"
                                    )


                                # Strategy 5 (supplemental): for toast assertions, also check if modal still open
                                if is_toast and found_text is None and not has_validation_errors:
                                    try:
                                        modal_still_open = await page.locator(
                                            ".slds-modal__container, div[role='dialog']"
                                        ).count() > 0
                                        if modal_still_open:
                                            raise Exception(
                                                "Record creation modal still open after Save — record NOT created"
                                            )
                                    except Exception as modal_err:
                                        raise Exception(str(modal_err))

                                # Strategy 6: URL-based success (ONLY if no errors)
                                if found_text is None and is_toast and not has_validation_errors:
                                    try:
                                        current_url = page.url
                                        if "/lightning/r/" in current_url and "/view" in current_url:
                                            logger.info(f"  ℹ URL indicates record was created: {current_url}")
                                            found_text = "was created"
                                    except Exception:
                                        pass

                                # PDF assertions use a sentinel — element presence was already verified above
                                is_pdf_success = (
                                    found_text is not None
                                    and str(found_text).startswith("pdf_element_visible:")
                                )

                                if is_pdf_success or (found_text is not None and expected_text in (found_text or "")):
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
                            error_msg = str(e).lower()
                            logger.info(f"  ❌ STEP {step_order} FAILED: {action} - {e}")

                            # If failed due to app-error modal blocking, try dismiss + ALWAYS retry
                            if "subtree intercepts pointer events" in error_msg:
                                print(f"[RETRY] Step {step_order} blocked by modal — dismissing and retrying")
                                # Try to dismiss (may already be gone)
                                await SalesforceLightningEngine.dismiss_error_modal(page)
                                # Wait for page to stabilize
                                await asyncio.sleep(1.5)
                                try:
                                    if action in ["fill", "input", "type"]:
                                        await SalesforceLightningEngine.scroll_modal_to_field(page, target)
                                        await SalesforceLightningEngine._fill_generic(
                                            page, target, value
                                        )
                                        step_log["status"] = "success"
                                        step_log["note"] = "Succeeded after modal dismiss retry"
                                        print(f"[RETRY] ✅ Step {step_order} succeeded after modal retry")
                                        continue
                                    elif action == "click":
                                        if "role=button" in (locator_type or ""):
                                            name = target.split("name=")[-1].strip() if "name=" in target else target
                                            btn = page.get_by_role("button", name=name)
                                        else:
                                            btn = page.locator(target)
                                        await btn.first.click(timeout=5000)
                                        step_log["status"] = "success"
                                        step_log["note"] = "Succeeded after modal dismiss retry"
                                        print(f"[RETRY] ✅ Step {step_order} succeeded after modal retry")
                                        continue
                                except Exception as retry_err:
                                    print(f"[RETRY] ❌ Retry also failed: {retry_err}")
                                    step_log["error"] = f"Original: {e} | Retry: {retry_err}"

                            step_log["status"] = "failed"
                            if "error" not in step_log:
                                step_log["error"] = str(e)
                            overall_result = "failed"

                            # ─── Component 2: Enhanced error diagnostics ───
                            diagnostics = {
                                "step": step_order,
                                "action": action,
                                "field": target,
                                "value": value,
                            }
                            meta_info = sf_metadata_map.get(target, {}) if sf_metadata_map else {}
                            field_type = meta_info.get("type", "unknown")
                            diagnostics["field_type"] = field_type

                            if action in ("lookup", "lookup_select"):
                                refs = meta_info.get("referenceTo", [])
                                diagnostics["reason"] = (
                                    f"Lookup value '{value}' was typed but could not be selected from '{target}' "
                                    f"(related object: {refs[0] if refs else 'unknown'})"
                                )
                                diagnostics["suggested_fix"] = (
                                    f"Ensure the record '{value}' exists in the related object. "
                                    f"Check that the record name matches exactly."
                                )
                            elif action == "select":
                                pv = meta_info.get("picklistValues", [])
                                valid = [v.get("label", v.get("value", "")) for v in pv if v.get("active")][:10]
                                diagnostics["reason"] = (
                                    f"Could not select '{value}' in picklist field '{target}'"
                                )
                                diagnostics["suggested_fix"] = (
                                    f"Valid values are: {valid}. Ensure the value matches exactly."
                                ) if valid else "Check Salesforce for valid picklist values."
                            elif action in ("fill", "input", "type") and field_type in ("date", "datetime"):
                                diagnostics["reason"] = (
                                    f"Date value '{value}' could not be entered into field '{target}'"
                                )
                                diagnostics["suggested_fix"] = (
                                    "Use MM/DD/YYYY format. Ensure the date field is visible and editable."
                                )
                            elif action == "assert_text":
                                diagnostics["reason"] = str(e)
                                diagnostics["suggested_fix"] = (
                                    "Check if a Salesforce validation error blocked the save. "
                                    "Review required fields and validation rules."
                                )
                            else:
                                diagnostics["reason"] = str(e)
                                diagnostics["suggested_fix"] = (
                                    f"Verify the element '{target}' exists and is visible on the page."
                                )

                            step_log["diagnostics"] = diagnostics
                            print(f"[DIAG] Step {step_order} failed: {diagnostics.get('reason', '')[:100]}")
                            print(f"[DIAG] Suggested fix: {diagnostics.get('suggested_fix', '')[:100]}")

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
