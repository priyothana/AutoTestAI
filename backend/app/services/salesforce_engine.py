"""
Salesforce Lightning Execution Engine

A dedicated engine for automating Salesforce Lightning UI.
Handles: dynamic field mapping, Lightning component detection,
modal awareness, auto-scroll, and retry logic.

This replaces all incremental Lightning patches in playwright_service.py
with a clean, self-contained engine.
"""
import asyncio
import logging
import re

logger = logging.getLogger(__name__)


class SalesforceLightningEngine:
    """Salesforce Lightning-aware execution engine for Playwright."""

    # Cache for loaded metadata (project_id → field_map)
    _metadata_cache = {}

    @staticmethod
    async def load_field_metadata(project_id: str) -> dict:
        """Load Salesforce field metadata from MetadataNormalized for a project.

        Returns a dict mapping field labels to their metadata:
        {
            "Tax Type": {"type": "picklist", "values": ["GST", "VAT"], "api_name": "Tax_Type__c", "required": True},
            "Order": {"type": "reference", "values": [], "api_name": "Order__c", "required": True},
        }
        """
        if project_id in SalesforceLightningEngine._metadata_cache:
            return SalesforceLightningEngine._metadata_cache[project_id]

        field_metadata = {}
        try:
            from app.db.session import AsyncSessionLocal
            from sqlalchemy.future import select
            from app.models.metadata_normalized import MetadataNormalized

            async with AsyncSessionLocal() as db:
                result = await db.execute(
                    select(MetadataNormalized).where(
                        MetadataNormalized.project_id == project_id,
                        MetadataNormalized.entity_type == "object",
                    )
                )
                records = result.scalars().all()

                for record in records:
                    structured = record.structured_json or {}
                    fields = structured.get("fields", [])
                    for field in fields:
                        label = field.get("label", "")
                        if not label:
                            continue
                        sf_type = (field.get("type", "string") or "string").lower()
                        picklist_values = [
                            pv.get("label", pv.get("value", ""))
                            for pv in field.get("picklistValues", [])
                            if pv.get("active", True)
                        ]
                        field_metadata[label] = {
                            "type": sf_type,
                            "values": picklist_values,
                            "api_name": field.get("api", ""),
                            "required": field.get("required", False),
                            "reference_to": field.get("referenceTo", []),
                        }

            SalesforceLightningEngine._metadata_cache[project_id] = field_metadata
            logger.info(f"  ℹ Loaded {len(field_metadata)} field metadata entries for project {project_id}")
        except Exception as e:
            logger.warning(f"  ⚠ Failed to load field metadata: {e}")

        return field_metadata

    # ─────────────────────────────────────────────
    # Page Readiness
    # ─────────────────────────────────────────────

    @staticmethod
    async def wait_for_page_ready(page):
        """Wait for a Salesforce Lightning page to be interactive.
        Never uses networkidle — Lightning SPAs make constant API calls."""
        try:
            await page.wait_for_load_state("load", timeout=15000)
        except Exception:
            pass
        await asyncio.sleep(3)

        # Wait for a real Lightning UI element
        ui_selectors = (
            "force-list-view-manager-header, .slds-page-header, "
            "lightning-button[variant], one-record-home-flexipage2, "
            ".forceListViewManager, a.tabHeader, lst-list-view-manager-header, "
            ".slds-page-header__title, records-highlights2"
        )
        try:
            await page.locator(ui_selectors).first.wait_for(
                state="visible", timeout=20000
            )
            logger.info("  ℹ Lightning page ready — real UI element visible")
        except Exception:
            await asyncio.sleep(3)
            logger.info("  ℹ Lightning page ready check timed out — continuing with fallback wait")

    # ─────────────────────────────────────────────
    # Modal Awareness
    # ─────────────────────────────────────────────

    @staticmethod
    async def wait_for_modal(page):
        """Wait for Salesforce modal to fully open, fields to render, and stabilize.
        Returns True if modal was detected, False otherwise.

        After clicking New/Edit/Clone, Salesforce dynamically loads a modal:
            div[role="dialog"]
                .slds-modal
                    .slds-modal__content
                        lightning-input-field (×N)

        This method waits for:
        1. Modal container to be visible
        2. At least one form field to be visible
        3. 800ms stabilization for Lightning components to initialize"""

        # Step 1: Wait for modal container
        modal_selectors = (
            "div[role='dialog'], .forceModal, .records-modal, "
            ".slds-modal, records-record-edit-form, "
            "lightning-record-edit-form, section.slds-modal, "
            "div.slds-modal__content"
        )
        modal_found = False
        try:
            await page.locator(modal_selectors).first.wait_for(
                state="visible", timeout=15000
            )
            modal_found = True
            logger.info("  ℹ Modal container detected")
        except Exception:
            logger.info("  ℹ Modal container not detected within 15s")
            return False

        # Step 2: Wait for form fields to render inside the modal
        if modal_found:
            field_selectors = (
                ".slds-form-element, lightning-input-field, "
                "lightning-input, lightning-combobox, lightning-datepicker"
            )
            try:
                await page.locator(field_selectors).first.wait_for(
                    state="visible", timeout=15000
                )
                logger.info("  ℹ Form fields detected in modal")
            except Exception:
                logger.info("  ℹ Form fields not detected within 15s — continuing anyway")

        # Step 3: Stabilization wait — allow Lightning components to fully initialize
        await asyncio.sleep(0.8)
        logger.info("  ℹ Modal stabilization complete — proceeding with field execution")
        return True

    # ─────────────────────────────────────────────
    # Dynamic Field Map Scanner
    # ─────────────────────────────────────────────

    @staticmethod
    async def scan_field_map(page):
        """Scan the current page/modal and build a {label → type} map.
        This allows the fill engine to know the correct interaction strategy."""
        try:
            field_map = await page.evaluate("""() => {
                const modal = document.querySelector(
                    '.slds-modal__content, records-record-edit-form, lightning-record-edit-form'
                ) || document.body;
                const map = {};

                // Scan lightning-input-field components
                modal.querySelectorAll('lightning-input-field').forEach(field => {
                    const label = field.querySelector('label, .slds-form-element__label, legend');
                    if (!label) return;
                    const labelText = label.textContent.trim();
                    if (!labelText) return;

                    // Detect field type from child components
                    if (field.querySelector('lightning-datepicker')) {
                        map[labelText] = 'date';
                    } else if (field.querySelector('lightning-combobox')) {
                        map[labelText] = 'picklist';
                    } else if (field.querySelector('lightning-lookup, lightning-grouped-combobox, input[role="combobox"]')) {
                        map[labelText] = 'lookup';
                    } else if (field.querySelector('lightning-textarea, textarea')) {
                        map[labelText] = 'textarea';
                    } else {
                        map[labelText] = 'text';
                    }
                });

                // Scan standalone lightning-input, lightning-combobox, lightning-datepicker
                ['lightning-input', 'lightning-combobox', 'lightning-datepicker',
                 'lightning-textarea', 'lightning-lookup'].forEach(tag => {
                    modal.querySelectorAll(tag).forEach(el => {
                        const label = el.querySelector('label, .slds-form-element__label');
                        if (!label) return;
                        const labelText = label.textContent.trim();
                        if (!labelText || map[labelText]) return;

                        if (tag === 'lightning-datepicker') map[labelText] = 'date';
                        else if (tag === 'lightning-combobox') map[labelText] = 'picklist';
                        else if (tag === 'lightning-lookup') map[labelText] = 'lookup';
                        else if (tag === 'lightning-textarea') map[labelText] = 'textarea';
                        else map[labelText] = 'text';
                    });
                });

                // Scan .slds-form-element containers as fallback
                modal.querySelectorAll('.slds-form-element').forEach(el => {
                    const label = el.querySelector('label, .slds-form-element__label, legend');
                    if (!label) return;
                    const labelText = label.textContent.trim();
                    if (!labelText || map[labelText]) return;

                    if (el.querySelector('input[type="date"], lightning-datepicker')) {
                        map[labelText] = 'date';
                    } else if (el.querySelector('select, lightning-combobox, [role="listbox"]')) {
                        map[labelText] = 'picklist';
                    } else if (el.querySelector('input[role="combobox"]')) {
                        map[labelText] = 'lookup';
                    } else if (el.querySelector('textarea')) {
                        map[labelText] = 'textarea';
                    } else {
                        map[labelText] = 'text';
                    }
                });

                // Detect buttons
                modal.querySelectorAll('button, a[role=button], lightning-button').forEach(btn => {
                    const text = btn.textContent?.trim();
                    if (text && !map[text]) map[text] = 'button';
                });

                return map;
            }""")
            logger.info(f"  📋 Field map: {field_map}")
            return field_map
        except Exception as e:
            logger.warning(f"  ⚠ Field map scan failed: {e}")
            return {}

    # ─────────────────────────────────────────────
    # Safe Click
    # ─────────────────────────────────────────────

    @staticmethod
    async def safe_click(page, locator, timeout=20000):
        """Salesforce-safe click engine with page-load + iframe awareness.

        When element isn't found on the main page:
        1. Waits for page to finish loading (VF pages, spinners, iframes)
        2. Searches inside all iframes for the target element
        3. Falls back to 3 click strategies if found

        Strategy 1: Normal Playwright click (scroll + visible + click)
        Strategy 2: Force click (bypasses actionability checks)
        Strategy 3: JavaScript element.click() dispatch"""

        actual_locator = locator  # may be reassigned to an iframe locator

        # ─── Step 1: Quick DOM check (8s) ───
        element_found = False
        try:
            await locator.wait_for(state="attached", timeout=8000)
            element_found = True
        except Exception:
            logger.info("  ℹ Element not in DOM after 8s — checking page load state...")

            # ─── Page-load awareness ───
            # VF pages, PDF generation, iframes can take 20-30s to fully render
            max_load_wait = 30
            waited = 0

            while waited < max_load_wait:
                # Check page load state
                try:
                    load_state = await page.evaluate("""() => {
                        const state = document.readyState;
                        const iframes = document.querySelectorAll('iframe');
                        let iframeLoading = false;
                        for (const iframe of iframes) {
                            try {
                                if (iframe.contentDocument && iframe.contentDocument.readyState !== 'complete') {
                                    iframeLoading = true;
                                }
                            } catch(e) {}
                        }
                        const spinners = document.querySelectorAll(
                            '.slds-spinner, .loading, .forceSpinner, ' +
                            '.slds-spinner_container:not(.slds-hide), lightning-spinner'
                        );
                        const hasSpinner = [...spinners].some(s => s.offsetParent !== null);
                        return {
                            readyState: state,
                            iframeLoading: iframeLoading,
                            hasSpinner: hasSpinner,
                            iframeCount: iframes.length
                        };
                    }""")
                    is_loading = (
                        load_state.get("readyState") != "complete"
                        or load_state.get("iframeLoading", False)
                        or load_state.get("hasSpinner", False)
                    )
                except Exception:
                    is_loading = False
                    load_state = {}

                if is_loading:
                    logger.info(
                        f"  ℹ Page still loading (waited {waited}s): "
                        f"readyState={load_state.get('readyState')}, "
                        f"iframe={load_state.get('iframeLoading')}, "
                        f"spinner={load_state.get('hasSpinner')}"
                    )

                await asyncio.sleep(3)
                waited += 3

                # Re-check if element appeared on main page
                try:
                    await locator.wait_for(state="attached", timeout=2000)
                    logger.info(f"  → Element appeared on main page after {waited}s!")
                    element_found = True
                    break
                except Exception:
                    pass

                # If page is done loading but element still not on main page, stop waiting
                if not is_loading and waited >= 6:
                    break

            # ─── Step 2: Search inside iframes if not found on main page ───
            if not element_found:
                logger.info("  ℹ Element not on main page — searching inside iframes...")
                iframe_locator = await SalesforceLightningEngine._find_in_frames(
                    page, locator
                )
                if iframe_locator:
                    actual_locator = iframe_locator
                    element_found = True
                    logger.info("  → Found element inside an iframe!")

            if not element_found:
                # Final attempt on main page
                try:
                    await locator.wait_for(state="attached", timeout=5000)
                    element_found = True
                except Exception:
                    # Log diagnostics before failing
                    await SalesforceLightningEngine._log_page_diagnostics(page)
                    raise Exception(
                        f"safe_click: element not found on main page or in any iframe "
                        f"(waited {waited + 13}s). The element may not exist on the current page."
                    )

        # Step 3: Scroll into view
        try:
            await actual_locator.scroll_into_view_if_needed(timeout=5000)
        except Exception:
            pass

        # Strategy 1: Normal Playwright click
        try:
            logger.info("  ℹ Click strategy 1: normal Playwright click")
            await actual_locator.wait_for(state="visible", timeout=10000)
            await actual_locator.click(timeout=10000)
            logger.info("  → Click strategy 1 succeeded")
            return True
        except Exception as e:
            logger.info(f"  ⚠ Click strategy 1 failed: {e}")

        # Strategy 2: Force click
        try:
            logger.info("  ℹ Click strategy 2: force click")
            await actual_locator.click(force=True, timeout=10000)
            logger.info("  → Click strategy 2 succeeded (force)")
            return True
        except Exception as e:
            logger.info(f"  ⚠ Click strategy 2 failed: {e}")

        # Strategy 3: JavaScript click
        try:
            logger.info("  ℹ Click strategy 3: JavaScript click")
            element = await actual_locator.element_handle(timeout=5000)
            if element:
                await element.evaluate("(el) => el.click()")
                logger.info("  → Click strategy 3 succeeded (JS)")
                return True
        except Exception as e:
            logger.info(f"  ⚠ Click strategy 3 failed: {e}")

        logger.error("  ✗ All click strategies failed")
        raise Exception("safe_click: all 3 strategies failed")

    @staticmethod
    async def _find_in_frames(page, original_locator):
        """Search for a target element inside all page frames (iframes).
        Handles VF pages, PDF previews, and embedded Salesforce content.
        Returns a locator inside the frame if found, None otherwise."""
        import re as _re

        # Extract button name from the original locator's string representation
        # Playwright locator str looks like: get_by_role("button", name="Save")
        locator_str = str(original_locator)
        name_match = _re.search(r'name="([^"]+)"', locator_str)
        button_name = name_match.group(1) if name_match else None

        # Also try to extract from common patterns
        if not button_name:
            # Try text= pattern
            text_match = _re.search(r'text="([^"]+)"', locator_str)
            button_name = text_match.group(1) if text_match else None

        logger.info(f"  ℹ Searching {len(page.frames)} frames for button: '{button_name}'")

        for frame in page.frames:
            if frame == page.main_frame:
                continue  # Already checked main page
            try:
                frame_url = frame.url or ""
                # Skip empty or about:blank frames
                if not frame_url or frame_url == "about:blank":
                    continue

                logger.info(f"  ℹ Checking frame: {frame_url[:80]}")

                # Strategy 1: Try role-based search if we have a name
                if button_name:
                    for role in ["button", "link", "menuitem"]:
                        try:
                            role_loc = frame.get_by_role(role, name=button_name, exact=False)
                            count = await role_loc.count()
                            if count > 0:
                                logger.info(
                                    f"  → Found '{button_name}' as role={role} in frame "
                                    f"({count} match(es))"
                                )
                                # Return first visible
                                for i in range(count):
                                    try:
                                        if await role_loc.nth(i).is_visible():
                                            return role_loc.nth(i)
                                    except Exception:
                                        continue
                                return role_loc.first
                        except Exception:
                            continue

                # Strategy 2: CSS selectors for common button patterns
                if button_name:
                    css_selectors = [
                        f"button:has-text('{button_name}')",
                        f"input[type='submit'][value='{button_name}']",
                        f"input[type='button'][value='{button_name}']",
                        f"a:has-text('{button_name}')",
                        f"[value='{button_name}']",
                        f"[title='{button_name}']",
                    ]
                    for css_sel in css_selectors:
                        try:
                            css_loc = frame.locator(css_sel)
                            if await css_loc.count() > 0:
                                logger.info(f"  → Found via CSS '{css_sel}' in frame")
                                return css_loc.first
                        except Exception:
                            continue

                # Strategy 3: Text-based search
                if button_name:
                    try:
                        text_loc = frame.get_by_text(button_name, exact=True)
                        if await text_loc.count() > 0:
                            logger.info(f"  → Found via exact text '{button_name}' in frame")
                            return text_loc.first
                    except Exception:
                        pass

            except Exception as frame_err:
                logger.debug(f"  Frame search failed: {frame_err}")
                continue

        return None

    @staticmethod
    async def _log_page_diagnostics(page):
        """Log available buttons on main page and all frames for debugging."""
        try:
            page_buttons = await page.evaluate("""() => {
                const btns = document.querySelectorAll(
                    'button, a[role="button"], [role="button"], lightning-button, input[type="submit"]'
                );
                return [...btns]
                    .filter(b => b.offsetParent !== null)
                    .map(b => (b.title || b.textContent || b.value || '').trim())
                    .filter(Boolean)
                    .slice(0, 20);
            }""")
            logger.info(f"  📋 Main page buttons: {page_buttons}")
        except Exception:
            pass

        for frame in page.frames:
            if frame == page.main_frame:
                continue
            try:
                frame_url = frame.url or ""
                if not frame_url or frame_url == "about:blank":
                    continue
                frame_btns_loc = frame.locator(
                    'button, input[type="submit"], input[type="button"], [role="button"], a'
                )
                count = await frame_btns_loc.count()
                if count > 0:
                    btns = []
                    for i in range(min(count, 10)):
                        try:
                            txt = await frame_btns_loc.nth(i).text_content(timeout=1000)
                            val = await frame_btns_loc.nth(i).get_attribute("value", timeout=500) if not txt else None
                            btns.append((txt or val or "").strip())
                        except Exception:
                            pass
                    btns = [b for b in btns if b]
                    if btns:
                        logger.info(f"  📋 Frame [{frame_url[:60]}] buttons: {btns}")
            except Exception:
                continue


    # ─────────────────────────────────────────────
    # Retry Logic
    # ─────────────────────────────────────────────

    @staticmethod
    async def retry(action, retries=3, delay=3):
        """Retry an async action up to `retries` times."""
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

    # ─────────────────────────────────────────────
    # Modal Scroll
    # ─────────────────────────────────────────────

    @staticmethod
    async def scroll_modal_to_field(page, label):
        """Scroll the modal container to bring a field into view using JS."""
        try:
            scrolled = await page.evaluate("""(labelText) => {
                const modal = document.querySelector(
                    '.slds-modal__content, div.modal-body, records-record-edit-form'
                );
                if (!modal) return false;

                // Find label elements containing our text
                const labels = [...modal.querySelectorAll(
                    'label, span.slds-form-element__label, legend, .test-id__field-label'
                )];
                const target = labels.find(
                    l => l.textContent && l.textContent.trim().includes(labelText)
                );
                if (target) {
                    target.scrollIntoView({ behavior: 'instant', block: 'center' });
                    return true;
                }
                // Label not found — scroll to bottom to reveal lazy-loaded fields
                modal.scrollTop = modal.scrollHeight;
                return false;
            }""", label)
            await asyncio.sleep(0.5)
            if scrolled:
                logger.info(f"  ℹ Scrolled modal to '{label}'")
            else:
                logger.info(f"  ℹ Label '{label}' not found in modal — scrolled to bottom")
        except Exception as e:
            logger.debug(f"  scroll_modal_to_field failed: {e}")

    # ─────────────────────────────────────────────
    # Locator Resolver (Lightning-Aware)
    # ─────────────────────────────────────────────

    @staticmethod
    async def resolve_locator(page, target, locator_type):
        """Resolve a Playwright locator using Salesforce-aware strategies.
        For role-based targets, tries multiple fallbacks.
        For label-based targets, prioritizes Lightning component selectors."""
        locator_type = (locator_type or "").lower().strip()
        target = (target or "").strip()

        # Auto-detect locator_type
        if not locator_type and target:
            if re.match(r"role=\w+,\s*name=", target):
                locator_type = "role"
            elif target.startswith("label="):
                locator_type = "label"
                target = target[6:]
            elif target.startswith("text="):
                locator_type = "text"
                target = target[5:]
            elif re.search(r'[.#\[\]>:=]', target):
                locator_type = "css"
            else:
                locator_type = "label"

        if locator_type == "role":
            role_match = re.match(r"role=(\w+),\s*name=(.+)", target)
            if role_match:
                role = role_match.group(1).strip()
                name = role_match.group(2).strip()
                return await SalesforceLightningEngine._resolve_role(page, role, name)
            return page.locator(target).first

        elif locator_type == "css":
            return page.locator(target).first

        elif locator_type == "text":
            loc = page.get_by_text(target, exact=False)
            if await loc.count() > 0:
                return loc.first
            return page.locator(f"text={target}").first

        else:
            # Label-based — use Lightning component resolution
            return await SalesforceLightningEngine._resolve_label(page, target)

    @staticmethod
    async def _resolve_role(page, role, name):
        """Smart Button Engine — resolves role-based locators for Salesforce Lightning.

        For action buttons (New, Edit, Save, etc.), searches inside the
        Lightning toolbar FIRST. Includes both <button> and <a> elements
        since Salesforce renders actions as either type."""

        sf_action_buttons = {"new", "edit", "save", "delete", "clone", "cancel", "import"}
        is_action_button = name.lower() in sf_action_buttons

        if is_action_button:
            logger.info(f"  ℹ Smart Button Engine: resolving '{name}'")

            # Build a comprehensive combined selector for toolbar actions
            # Includes both button and a (anchor) elements
            combined_toolbar = (
                f"div[role='toolbar'] button[title='{name}'], "
                f"div[role='toolbar'] a[title='{name}'], "
                f"ul[role='toolbar'] button[title='{name}'], "
                f"ul[role='toolbar'] a[title='{name}'], "
                f"runtime_platform_actions-action-bar button[title='{name}'], "
                f"runtime_platform_actions-action-bar a[title='{name}'], "
                f"force-list-view-manager-header button[title='{name}'], "
                f"force-list-view-manager-header a[title='{name}'], "
                f"lst-list-view-manager-header button[title='{name}'], "
                f"lst-list-view-manager-header a[title='{name}'], "
                f".slds-page-header button[title='{name}'], "
                f".slds-page-header a[title='{name}'], "
                f"one-record-home-flexipage2 button[title='{name}'], "
                f"one-record-home-flexipage2 a[title='{name}'], "
                f"lightning-button:has-text('{name}'), "
                f"lightning-button-menu:has-text('{name}'), "
                f"runtime_platform_actions-action-renderer a[title='{name}'], "
                f"runtime_platform_actions-action-renderer button[title='{name}']"
            )

            # Wait up to 15s for any toolbar element to appear
            combo_loc = page.locator(combined_toolbar)
            try:
                await combo_loc.first.wait_for(state="visible", timeout=15000)
                count = await combo_loc.count()
                logger.info(f"  → Smart Button: {count} toolbar match(es) for '{name}'")
                # Return first visible one
                for i in range(count):
                    try:
                        if await combo_loc.nth(i).is_visible():
                            return combo_loc.nth(i)
                    except Exception:
                        continue
                return combo_loc.first
            except Exception:
                logger.info(f"  ℹ Smart Button: no toolbar match within 15s for '{name}'")

            # Fallback: visible button or link anywhere on page
            try:
                visible_loc = page.locator(
                    f"button:has-text('{name}'):visible, a:has-text('{name}'):visible, "
                    f"[role='button']:has-text('{name}'):visible"
                )
                count = await visible_loc.count()
                if count > 0:
                    logger.info(f"  → Smart Button: visible element match ({count} found)")
                    return visible_loc.first
            except Exception:
                pass

            # Debug: log all visible action elements
            try:
                toolbar_info = await page.evaluate("""() => {
                    const btns = document.querySelectorAll(
                        'div[role="toolbar"] button, div[role="toolbar"] a, ' +
                        '.slds-page-header button, .slds-page-header a, ' +
                        '[class*="action"] button, [class*="action"] a'
                    );
                    return [...btns]
                        .filter(b => b.offsetParent !== null)
                        .map(b => b.tagName + ':' + (b.title || b.textContent?.trim() || '').substring(0, 30))
                        .filter(Boolean)
                        .slice(0, 15);
                }""")
                logger.info(f"  ℹ Visible toolbar elements: {toolbar_info}")
            except Exception:
                pass

        # ─── Generic role resolution (non-action buttons or fallback) ───
        best_match = None

        # Try the exact role
        loc = page.get_by_role(role, name=name, exact=False)
        if await loc.count() > 0:
            for i in range(await loc.count()):
                try:
                    if await loc.nth(i).is_visible():
                        return loc.nth(i)
                except Exception:
                    continue
            best_match = loc.first

        # Try alternative roles
        for alt in ["button", "link", "menuitem", "tab"]:
            if alt == role:
                continue
            alt_loc = page.get_by_role(alt, name=name, exact=False)
            if await alt_loc.count() > 0:
                for i in range(await alt_loc.count()):
                    try:
                        if await alt_loc.nth(i).is_visible():
                            logger.info(f"  → Resolved '{name}' via alt role '{alt}'")
                            return alt_loc.nth(i)
                    except Exception:
                        continue
                if not best_match:
                    best_match = alt_loc.first

        if best_match:
            return best_match

        # Absolute last resort
        logger.warning(f"  ⚠ All strategies failed for role={role}, name={name}")
        return page.get_by_role(role, name=name, exact=False).first

    @staticmethod
    async def _resolve_label(page, label):
        """Resolve a label-based locator using Lightning component strategies.
        This is the PRIMARY fix for date fields — never relies on get_by_label alone."""
        # Clean API names like "Designation__c" → "Designation"
        labels_to_try = [label]
        if "__c" in label or "__r" in label:
            clean = re.sub(r'__c$|__r$', '', label).replace('_', ' ').strip()
            if clean != label:
                labels_to_try.insert(0, clean)

        for lbl in labels_to_try:
            # Strategy 1: Lightning component selectors (highest priority)
            component_selectors = [
                f"lightning-input-field:has-text('{lbl}') input",
                f"lightning-datepicker:has-text('{lbl}') input",
                f"lightning-input:has-text('{lbl}') input",
                f"lightning-combobox:has-text('{lbl}') input",
                f"lightning-textarea:has-text('{lbl}') textarea",
                f"input[aria-label='{lbl}']",
                f"input[name='{lbl}']",
                f"textarea[name='{lbl}']",
            ]
            for sel in component_selectors:
                try:
                    loc = page.locator(sel)
                    if await loc.count() > 0:
                        logger.info(f"  → Resolved '{lbl}' via component: {sel}")
                        return loc.first
                except Exception:
                    continue

            # Strategy 2: Modal-scoped get_by_label
            modal_scopes = [
                "div.slds-modal__content",
                "records-record-edit-form",
                "section.slds-modal",
            ]
            for scope_sel in modal_scopes:
                try:
                    scope = page.locator(scope_sel)
                    if await scope.count() > 0:
                        scoped = scope.first.get_by_label(lbl, exact=True)
                        if await scoped.count() > 0:
                            logger.info(f"  → Resolved '{lbl}' via modal-scoped get_by_label")
                            return scoped.first
                except Exception:
                    continue

            # Strategy 3: Full-page get_by_label
            try:
                gbl = page.get_by_label(lbl, exact=True)
                if await gbl.count() > 0:
                    logger.info(f"  → Resolved '{lbl}' via get_by_label")
                    return gbl.first
            except Exception:
                pass

            # Strategy 4: get_by_role textbox
            try:
                tb = page.get_by_role("textbox", name=lbl, exact=False)
                if await tb.count() > 0:
                    logger.info(f"  → Resolved '{lbl}' via textbox role")
                    return tb.first
            except Exception:
                pass

            # Strategy 5: XPath label → nearest input
            try:
                xpath = page.locator(
                    f"xpath=//label[contains(.,'{lbl}')]/ancestor::*[contains(@class,'slds-form-element')][1]//input | "
                    f"//span[text()='{lbl}']/ancestor::*[contains(@class,'slds-form-element')][1]//input"
                )
                if await xpath.count() > 0:
                    logger.info(f"  → Resolved '{lbl}' via XPath near label")
                    return xpath.first
            except Exception:
                pass

            # Strategy 6: get_by_placeholder
            try:
                ph = page.get_by_placeholder(lbl, exact=False)
                if await ph.count() > 0:
                    logger.info(f"  → Resolved '{lbl}' via placeholder")
                    return ph.first
            except Exception:
                pass

        # Nothing found — return get_by_label to let Playwright show clear error
        logger.warning(f"  ⚠ All label strategies failed for '{label}'")
        return page.get_by_label(label, exact=True).first

    # ─────────────────────────────────────────────
    # Universal Field Fill Engine
    # ─────────────────────────────────────────────

    @staticmethod
    async def fill_field(page, label, value, field_map=None, metadata_map=None):
        """Universal Salesforce field filler.
        Uses metadata_map (from MCP) or field_map (from UI scan) to determine type.
        Falls back to JS DOM traversal if Playwright locators fail."""

        field_type = (field_map or {}).get(label, "unknown")

        # ─── Fuzzy label correction: find best matching label on page ───
        corrected_label = label
        if field_type == "unknown":
            corrected_label = await SalesforceLightningEngine._correct_label(page, label, metadata_map)
            if corrected_label != label:
                logger.info(f"  ℹ Label corrected: '{label}' → '{corrected_label}'")
                # Re-check field_map with corrected label
                field_type = (field_map or {}).get(corrected_label, "unknown")
                label = corrected_label

        # ─── Metadata override: use MCP metadata as source of truth ───
        if metadata_map and field_type == "unknown":
            meta = metadata_map.get(label)
            if not meta:
                # Try case-insensitive partial match
                for meta_label, meta_info in metadata_map.items():
                    if label.lower() in meta_label.lower() or meta_label.lower() in label.lower():
                        meta = meta_info
                        break
            if not meta:
                # Fuzzy word overlap match
                meta = SalesforceLightningEngine._fuzzy_match_metadata(label, metadata_map)
            if meta:
                sf_type = meta.get("type", "")
                # Map Salesforce API types to engine types
                type_mapping = {
                    "picklist": "picklist",
                    "multipicklist": "picklist",
                    "combobox": "picklist",
                    "reference": "lookup",
                    "date": "date",
                    "datetime": "date",
                    "boolean": "checkbox",
                    "textarea": "text",
                    "string": "text",
                    "email": "text",
                    "phone": "text",
                    "url": "text",
                    "currency": "text",
                    "double": "text",
                    "int": "text",
                    "percent": "text",
                }
                mapped_type = type_mapping.get(sf_type, "text")
                logger.info(f"  ℹ Metadata override: '{label}' → {sf_type} → {mapped_type}")
                field_type = mapped_type

        # Also check partial matches in field_map (label might have extra whitespace)
        if field_type == "unknown" and field_map:
            for map_label, map_type in field_map.items():
                if label.lower() in map_label.lower() or map_label.lower() in label.lower():
                    field_type = map_type
                    logger.info(f"  ℹ Partial field map match: '{label}' → '{map_label}' ({map_type})")
                    break

    @staticmethod
    def _fuzzy_match_metadata(label, metadata_map):
        """Find the best fuzzy match for a label in the metadata map using word overlap."""
        label_words = set(label.lower().split())
        best_match = None
        best_score = 0

        for meta_label, meta_info in metadata_map.items():
            meta_words = set(meta_label.lower().split())
            if not meta_words:
                continue
            # Word overlap score
            overlap = len(label_words & meta_words)
            total = max(len(label_words), len(meta_words))
            score = overlap / total if total > 0 else 0

            if score > best_score and score >= 0.5:  # At least 50% word overlap
                best_score = score
                best_match = meta_info

        return best_match

    @staticmethod
    async def _correct_label(page, label, metadata_map=None):
        """Try to correct a mismatched label by scanning visible labels on the page.
        Uses word overlap scoring to find the best match."""
        try:
            page_labels = await page.evaluate("""() => {
                const root = document.querySelector(
                    '.slds-modal__content, records-record-edit-form'
                ) || document.body;
                const labels = root.querySelectorAll(
                    'label, span.slds-form-element__label, legend'
                );
                return [...labels]
                    .map(l => l.textContent?.trim())
                    .filter(Boolean)
                    .map(t => t.replace(/^\\*/, '').trim());
            }""")

            if not page_labels:
                return label

            label_words = set(label.lower().split())
            best_match = label
            best_score = 0

            for page_lbl in page_labels:
                page_words = set(page_lbl.lower().split())
                if not page_words:
                    continue
                overlap = len(label_words & page_words)
                total = max(len(label_words), len(page_words))
                score = overlap / total if total > 0 else 0

                # Must have at least 50% word overlap and at least 2 matching words
                if score > best_score and score >= 0.5 and overlap >= 2:
                    best_score = score
                    best_match = page_lbl

            return best_match
        except Exception:
            return label

        # Real-time JS probe: detect actual field type by inspecting DOM
        # This catches picklists that scan_field_map missed
        if field_type in ("unknown", "text"):
            try:
                probed_type = await page.evaluate("""(labelText) => {
                    const root = document.querySelector(
                        '.slds-modal__content, records-record-edit-form, lightning-record-edit-form'
                    ) || document.body;
                    const labels = root.querySelectorAll(
                        'label, span.slds-form-element__label, legend, .test-id__field-label'
                    );
                    for (const lbl of labels) {
                        const txt = lbl.textContent?.trim();
                        if (!txt || !txt.includes(labelText)) continue;
                        // Walk up to container
                        const container = lbl.closest(
                            'lightning-input-field, lightning-combobox, lightning-picklist, ' +
                            'lightning-grouped-combobox, .slds-form-element'
                        );
                        if (!container) continue;
                        // Check for date FIRST (before combobox, since date inputs can have role=combobox)
                        if (container.querySelector('lightning-datepicker')) return 'date';
                        // Check for picklist indicators
                        if (container.querySelector('lightning-combobox, lightning-picklist, [role="listbox"]')) return 'picklist';
                        const btn = container.querySelector('button');
                        if (btn) {
                            const btnText = btn.textContent?.trim();
                            if (btnText === '--None--' || btnText === 'Select an Option' ||
                                btnText === 'None' || btn.getAttribute('aria-haspopup') === 'listbox') {
                                return 'picklist';
                            }
                        }
                        const combobox = container.querySelector('[role="combobox"], input[role="combobox"]');
                        // Only treat as picklist if there's no datepicker ancestor
                        if (combobox && !container.querySelector('lightning-datepicker')) return 'picklist';
                        if (container.querySelector('lightning-lookup')) return 'lookup';
                        if (container.querySelector('textarea, lightning-textarea')) return 'textarea';
                        return 'text';
                    }
                    return null;
                }""", label)
                if probed_type and probed_type != field_type:
                    logger.info(f"  ℹ JS probe reclassified '{label}': {field_type} → {probed_type}")
                    field_type = probed_type
            except Exception as e:
                logger.debug(f"  JS field probe failed: {e}")

        logger.info(f"  ℹ Filling '{label}' (detected type: {field_type}) with value '{value}'")
        print(f"[FIELD] Filling '{label}' → detected type: {field_type}, value: '{value}'")

        # Step 1: Scroll modal to bring field into view
        await SalesforceLightningEngine.scroll_modal_to_field(page, label)

        # Step 2: Try type-specific strategies
        if field_type == "date":
            success = await SalesforceLightningEngine._fill_date(page, label, value)
            if success:
                return
        elif field_type == "picklist":
            success = await SalesforceLightningEngine._fill_picklist(page, label, value)
            if success:
                return
        elif field_type == "lookup":
            success = await SalesforceLightningEngine._fill_lookup(page, label, value)
            if success:
                return

        # Step 3: Try picklist BEFORE generic fill for unknown types
        # Generic fill clicking on a readonly combobox input corrupts the UI state
        if field_type not in ("picklist", "date"):
            success = await SalesforceLightningEngine._fill_picklist(page, label, value)
            if success:
                return

        # Step 4: Generic fill (text / textarea)
        success = await SalesforceLightningEngine._fill_generic(page, label, value)
        if success:
            return

        # Step 5: Try lookup
        if field_type != "lookup":
            success = await SalesforceLightningEngine._fill_lookup(page, label, value)
            if success:
                return

        # Step 6: JS DOM traversal — last resort
        success = await SalesforceLightningEngine._fill_via_js(page, label, value)
        if success:
            return

        # All strategies exhausted — dump page state for debugging
        try:
            debug_info = await page.evaluate("""() => {
                const root = document.querySelector(
                    '.slds-modal__content, records-record-edit-form'
                ) || document.body;
                const labels = [...root.querySelectorAll(
                    'label, span.slds-form-element__label, legend'
                )].map(l => l.textContent?.trim()).filter(Boolean).slice(0, 30);
                const buttons = [...root.querySelectorAll(
                    'button, [role=combobox]'
                )].filter(b => b.offsetParent !== null)
                    .map(b => b.tagName + ':' + (b.textContent?.trim() || b.getAttribute('aria-label') || '').substring(0, 40))
                    .slice(0, 20);
                return { labels, buttons, hasModal: !!document.querySelector('.slds-modal') };
            }""")
            logger.error(f"  🔍 DEBUG dump for failed field '{label}': labels={debug_info.get('labels')}, buttons={debug_info.get('buttons')}, modal={debug_info.get('hasModal')}")
        except Exception:
            pass

        raise Exception(f"Could not fill field '{label}' — all strategies exhausted")

    @staticmethod
    async def _fill_date(page, label, value):
        """Fill a Lightning date field: click → select all → type → Tab."""
        print(f"[DATE] 📅 Filling date field '{label}' with value '{value}'")
        selectors = [
            f"lightning-datepicker:has-text('{label}') input",
            f"lightning-input-field:has-text('{label}') input",
            f"lightning-input:has-text('{label}') input",
            f"input[aria-label='{label}']",
            f".slds-form-element:has-text('{label}') input[type='text']",
        ]
        for sel in selectors:
            try:
                loc = page.locator(sel)
                if await loc.count() == 0:
                    continue
                el = loc.first
                await el.scroll_into_view_if_needed(timeout=5000)
                await el.click(timeout=5000)
                await asyncio.sleep(0.3)

                # Triple-click to select all (cross-platform)
                await el.click(click_count=3, timeout=3000)
                await asyncio.sleep(0.2)

                # Type date value character by character (more reliable than fill)
                await page.keyboard.type(value or "", delay=50)
                await asyncio.sleep(0.3)
                await page.keyboard.press("Tab")
                await asyncio.sleep(0.5)

                # Dismiss any date popup that may have opened
                try:
                    await page.keyboard.press("Escape")
                    await asyncio.sleep(0.3)
                except Exception:
                    pass

                logger.info(f"  → Date field '{label}' filled via {sel}")
                print(f"[DATE] ✅ Date field '{label}' filled via {sel}")
                return True
            except Exception as e:
                logger.debug(f"  Date strategy {sel} failed: {e}")
                print(f"[DATE] ⚠ Strategy failed ({sel}): {e}")
                continue

        # Fallback: try get_by_label
        try:
            el = page.get_by_label(label, exact=False).first
            if await el.count() > 0:
                await el.click(timeout=5000)
                await el.click(click_count=3, timeout=3000)
                await asyncio.sleep(0.2)
                await page.keyboard.type(value or "", delay=50)
                await page.keyboard.press("Tab")
                await asyncio.sleep(0.5)
                logger.info(f"  → Date field '{label}' filled via get_by_label")
                return True
        except Exception:
            pass

        # JS fallback for date fields
        try:
            found = await page.evaluate("""(args) => {
                const [labelText, val] = args;
                const containers = document.querySelectorAll(
                    'lightning-datepicker, lightning-input-field, .slds-form-element'
                );
                for (const container of containers) {
                    const lbl = container.querySelector('label, .slds-form-element__label, legend');
                    if (!lbl || !lbl.textContent.trim().includes(labelText)) continue;
                    const input = container.querySelector('input');
                    if (!input) continue;
                    input.scrollIntoView({ behavior: 'instant', block: 'center' });
                    const setter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    ).set;
                    setter.call(input, val);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new Event('blur', { bubbles: true }));
                    return true;
                }
                return false;
            }""", [label, value or ""])
            if found:
                await page.keyboard.press("Tab")
                await asyncio.sleep(0.3)
                logger.info(f"  → Date field '{label}' filled via JS")
                return True
        except Exception as e:
            logger.debug(f"  Date JS fallback failed: {e}")
        return False

    @staticmethod
    async def _fill_picklist(page, label, value):
        """Fill a Lightning picklist using Playwright-first approach.

        Playwright locators auto-pierce Shadow DOM, so they can reach into
        Lightning component internals where page.evaluate() JS cannot.

        Strategy 1: Playwright container:has-text → button trigger
        Strategy 2: Playwright get_by_label → combobox
        Strategy 3: Find all visible --None-- buttons, match to label
        Strategy 4: JS fallback for edge cases"""

        async def _try_click_and_select(trigger_loc, strategy_name):
            """Click a trigger locator, wait for dropdown, select option, VERIFY."""
            try:
                await trigger_loc.scroll_into_view_if_needed(timeout=5000)
            except Exception:
                pass
            try:
                await trigger_loc.click(timeout=5000)
            except Exception:
                # Force click fallback
                try:
                    await trigger_loc.click(force=True, timeout=5000)
                except Exception:
                    return False
            await asyncio.sleep(2)
            option_found = await SalesforceLightningEngine._select_picklist_option(page, value)
            if option_found:
                await asyncio.sleep(0.5)
                # ─── Verify the selection was accepted ───
                # Read back the trigger button's displayed text
                try:
                    displayed = await trigger_loc.text_content(timeout=3000)
                    displayed_clean = (displayed or "").strip()
                    print(f"[PICKLIST-DEBUG] '{label}' trigger shows: '{displayed_clean}', wanted: '{value}'")
                    if displayed_clean and value.lower() in displayed_clean.lower():
                        print(f"[PICKLIST] ✅ '{label}' = '{value}' via {strategy_name} (verified)")
                        return True
                    else:
                        print(f"[PICKLIST] ⚠ Display mismatch: '{displayed_clean}' ≠ '{value}'")
                except Exception as verify_err:
                    print(f"[PICKLIST-DEBUG] Verification read failed: {verify_err}")

                # Alternative verification: check any visible combobox/button in the container
                try:
                    for container_sel in container_selectors:
                        container = page.locator(container_sel)
                        if await container.count() > 0:
                            container_text = await container.first.text_content(timeout=2000)
                            if container_text and value.lower() in container_text.strip().lower():
                                print(f"[PICKLIST] ✅ '{label}' = '{value}' via {strategy_name} (container verified)")
                                return True
                except Exception:
                    pass

                # Verification FAILED — don't return True blindly
                print(f"[PICKLIST] ✗ '{label}' option clicked but NOT verified via {strategy_name} — trying next strategy")
                return False
            await page.keyboard.press("Escape")
            await asyncio.sleep(0.5)
            return False

        # ─── Strategy 0: Native HTML <select> element ───
        # Some Salesforce fields (e.g. Lead Status in edit modals) use native
        # <select> elements instead of Lightning combobox. Playwright's
        # select_option() is the correct way to interact with these.
        native_select_selectors = [
            f".slds-form-element:has-text('{label}') select",
            f"lightning-input-field:has-text('{label}') select",
            f"lightning-picklist:has-text('{label}') select",
        ]
        for ns_sel in native_select_selectors:
            try:
                select_el = page.locator(ns_sel)
                if await select_el.count() > 0 and await select_el.first.is_visible():
                    # Try select_option by label text first
                    try:
                        await select_el.first.select_option(label=value, timeout=5000)
                        logger.info(f"  ✅ Picklist '{label}' = '{value}' via native <select> (label match)")
                        return True
                    except Exception:
                        pass
                    # Try by value attribute
                    try:
                        await select_el.first.select_option(value=value, timeout=5000)
                        logger.info(f"  ✅ Picklist '{label}' = '{value}' via native <select> (value match)")
                        return True
                    except Exception:
                        pass
                    # Try case-insensitive: get all options and find match
                    try:
                        options = await select_el.first.evaluate("""(sel) => {
                            return Array.from(sel.options).map(o => ({
                                value: o.value,
                                text: o.textContent.trim(),
                                label: o.label
                            }));
                        }""")
                        for opt in options:
                            if (value.lower() in opt.get('text', '').lower() or
                                value.lower() in opt.get('label', '').lower() or
                                value.lower() == opt.get('value', '').lower()):
                                await select_el.first.select_option(value=opt['value'], timeout=5000)
                                logger.info(f"  ✅ Picklist '{label}' = '{value}' via native <select> (fuzzy match: '{opt['text']}')")
                                return True
                    except Exception:
                        pass
            except Exception:
                continue

        # Also try get_by_label for native select
        try:
            sel_by_label = page.get_by_label(label, exact=False)
            if await sel_by_label.count() > 0:
                tag = await sel_by_label.first.evaluate("el => el.tagName.toLowerCase()")
                if tag == "select":
                    try:
                        await sel_by_label.first.select_option(label=value, timeout=5000)
                        logger.info(f"  ✅ Picklist '{label}' = '{value}' via get_by_label native <select>")
                        return True
                    except Exception:
                        pass
                    try:
                        await sel_by_label.first.select_option(value=value, timeout=5000)
                        logger.info(f"  ✅ Picklist '{label}' = '{value}' via get_by_label native <select> (value)")
                        return True
                    except Exception:
                        pass
        except Exception:
            pass

        # ─── Strategy 1: Playwright container:has-text → find button trigger ───
        # Playwright's :has-text() pierces Shadow DOM, so this works even when
        # the label is outside the lightning-combobox component
        container_selectors = [
            f".slds-form-element:has-text('{label}')",
            f"lightning-input-field:has-text('{label}')",
            f"lightning-grouped-combobox:has-text('{label}')",
            f"lightning-combobox:has-text('{label}')",
            f"lightning-picklist:has-text('{label}')",
        ]
        trigger_selectors = [
            "button",
            "[role='combobox']",
            "input[role='combobox']",
            "div[role='combobox']",
        ]

        for container_sel in container_selectors:
            try:
                containers = page.locator(container_sel)
                count = await containers.count()
                if count == 0:
                    continue

                logger.info(f"  ℹ Picklist S1: found {count} containers via {container_sel}")

                # Try each container (may match multiple, e.g. nested .slds-form-element)
                for ci in range(min(count, 3)):
                    container = containers.nth(ci)
                    for trigger_sel in trigger_selectors:
                        btn = container.locator(trigger_sel)
                        btn_count = await btn.count()
                        if btn_count > 0:
                            logger.info(f"  ℹ Picklist S1: trigger {trigger_sel} found in container {ci}")
                            if await _try_click_and_select(btn.first, f"S1:{container_sel}>{trigger_sel}"):
                                return True
            except Exception as e:
                logger.debug(f"  Picklist S1 {container_sel} error: {e}")
                continue

        # ─── Strategy 2: Playwright get_by_label → combobox interaction ───
        try:
            combobox = page.get_by_label(label, exact=False)
            count = await combobox.count()
            if count > 0:
                logger.info(f"  ℹ Picklist S2: get_by_label found {count} match(es)")
                for i in range(min(count, 3)):
                    el = combobox.nth(i)
                    if await _try_click_and_select(el, "S2:get_by_label"):
                        return True
        except Exception as e:
            logger.debug(f"  Picklist S2 error: {e}")

        # ─── Strategy 3: Find all --None-- buttons and match to label ───
        try:
            none_buttons = page.locator("button:has-text('--None--')")
            none_count = await none_buttons.count()
            logger.info(f"  ℹ Picklist S3: found {none_count} '--None--' buttons")

            for i in range(none_count):
                btn = none_buttons.nth(i)
                try:
                    # Check if this button is near our label via Playwright
                    # Get the closest .slds-form-element ancestor
                    parent_form_el = page.locator(
                        f".slds-form-element:has-text('{label}') button:has-text('--None--')"
                    )
                    if await parent_form_el.count() > 0:
                        logger.info(f"  ℹ Picklist S3: matched --None-- to '{label}'")
                        if await _try_click_and_select(parent_form_el.first, "S3:--None--"):
                            return True
                        break
                except Exception:
                    continue

            # Also try other default button texts
            for default_text in ["Select an Option", "None"]:
                try:
                    default_btns = page.locator(
                        f".slds-form-element:has-text('{label}') button:has-text('{default_text}')"
                    )
                    if await default_btns.count() > 0:
                        if await _try_click_and_select(default_btns.first, f"S3:{default_text}"):
                            return True
                except Exception:
                    continue
        except Exception as e:
            logger.debug(f"  Picklist S3 error: {e}")

        # ─── Strategy 4: JS fallback — find label, walk DOM, click trigger ───
        try:
            trigger_info = await page.evaluate("""(labelText) => {
                const root = document.querySelector(
                    '.slds-modal__content, records-record-edit-form'
                ) || document.body;
                const labels = root.querySelectorAll('label, span.slds-form-element__label');
                const labelLower = labelText.toLowerCase();

                for (const lbl of labels) {
                    const txt = lbl.textContent?.trim();
                    if (!txt || !txt.toLowerCase().includes(labelLower)) continue;

                    // Try closest .slds-form-element
                    const container = lbl.closest('.slds-form-element');
                    if (!container) continue;

                    const trigger = container.querySelector(
                        'button, [role="combobox"], input[role="combobox"]'
                    );
                    if (!trigger) continue;

                    trigger.scrollIntoView({ behavior: 'instant', block: 'center' });
                    trigger.click();
                    return { found: true, tag: trigger.tagName, text: trigger.textContent?.trim()?.substring(0, 20) };
                }
                return { found: false };
            }""", label)

            if trigger_info.get("found"):
                logger.info(f"  ℹ Picklist S4 (JS): clicked {trigger_info.get('tag')} '{trigger_info.get('text')}'")
                await asyncio.sleep(2)
                option_found = await SalesforceLightningEngine._select_picklist_option(page, value)
                if option_found:
                    logger.info(f"  → Picklist '{label}' = '{value}' via S4:JS")
                    return True
                await page.keyboard.press("Escape")
        except Exception as e:
            logger.debug(f"  Picklist S4 JS error: {e}")

        # ─── Strategy 5: Native <select> ───
        try:
            select = page.locator(f".slds-form-element:has-text('{label}') select")
            if await select.count() > 0:
                await select.first.select_option(label=value)
                logger.info(f"  → Picklist '{label}' = '{value}' via S5:<select>")
                return True
        except Exception:
            pass

        return False

    @staticmethod
    async def _select_picklist_option(page, value):
        """Try to find and click a picklist option matching the value.
        Called after a dropdown trigger has been clicked.
        Uses case-insensitive matching and multiple selector strategies."""

        # Count available options for debug logging
        try:
            opt_count = await page.locator(
                "[role='option'], lightning-base-combobox-item, .slds-listbox__item"
            ).count()
            logger.info(f"  ℹ Dropdown has {opt_count} options visible")
        except Exception:
            pass

        # Try Playwright selectors (exact match first)
        option_selectors = [
            f"lightning-base-combobox-item:has-text('{value}')",
            f"span.slds-truncate[title='{value}']",
            f"span[title='{value}']",
            f"[role='option']:has-text('{value}')",
            f"[data-value='{value}']",
            f".slds-listbox__item:has-text('{value}')",
        ]
        for opt_sel in option_selectors:
            try:
                option = page.locator(opt_sel)
                if await option.count() > 0:
                    await option.first.click(timeout=5000)
                    logger.info(f"  → Option selected via: {opt_sel}")
                    return True
            except Exception:
                continue

        # Case-insensitive partial match via Playwright
        try:
            options = page.locator(
                "[role='option'], lightning-base-combobox-item, .slds-listbox__item"
            )
            count = await options.count()
            for i in range(count):
                opt_text = await options.nth(i).text_content()
                if opt_text and value.lower() in opt_text.strip().lower():
                    await options.nth(i).click(timeout=5000)
                    logger.info(f"  → Option selected via case-insensitive match: '{opt_text.strip()}'")
                    return True
        except Exception:
            pass

        # JS-based option click (last resort)
        try:
            clicked = await page.evaluate("""(val) => {
                const valLower = val.toLowerCase();
                const options = document.querySelectorAll(
                    '[role="option"], lightning-base-combobox-item, ' +
                    '.slds-listbox__item, [role="listbox"] li'
                );
                for (const opt of options) {
                    const text = opt.textContent?.trim();
                    if (!text) continue;
                    // Case-insensitive matching
                    if (text.toLowerCase() === valLower ||
                        text.toLowerCase().includes(valLower) ||
                        valLower.includes(text.toLowerCase())) {
                        opt.scrollIntoView({ behavior: 'instant', block: 'center' });
                        opt.click();
                        return true;
                    }
                    if (opt.getAttribute('data-value')?.toLowerCase() === valLower) {
                        opt.click();
                        return true;
                    }
                    const span = opt.querySelector('span[title]');
                    if (span && span.getAttribute('title')?.toLowerCase().includes(valLower)) {
                        opt.click();
                        return true;
                    }
                }
                return false;
            }""", value)
            if clicked:
                logger.info(f"  → Option selected via JS click")
                return True
        except Exception:
            pass

        return False
    @staticmethod
    async def _fill_lookup(page, label, value):
        """Fill a Lightning lookup field with advanced search fallback.

        Strategy:
        1. Find lookup input (Lightning combobox or grouped-combobox)
        2. Type value → wait for suggestion dropdown (with retries)
        3. If suggestion found → click it
        4. If not → open Advanced Search modal → search → select record
        """
        logger.info(f"  🔍 Lookup: '{label}' → '{value}'")
        print(f"[LOOKUP] 🔍 Starting lookup for '{label}' = '{value}'")

        # ─── Step 1: Find the lookup input ───
        input_loc = None

        # Priority 1: get_by_label (most precise — uses Salesforce's label association)
        try:
            loc = page.get_by_label(label, exact=False)
            if await loc.count() > 0:
                # Verify it's a combobox/input
                tag = await loc.first.evaluate("el => el.tagName.toLowerCase()")
                if tag == 'input':
                    input_loc = loc.first
                    print(f"[LOOKUP] → Input found via get_by_label for '{label}'")
        except Exception:
            pass

        # Priority 2: CSS selectors with :has-text()
        if not input_loc:
            input_selectors = [
                f"lightning-input-field:has-text('{label}') input[role='combobox']",
                f"lightning-grouped-combobox:has-text('{label}') input",
                f"lightning-lookup:has-text('{label}') input",
                f".slds-form-element:has-text('{label}') input[role='combobox']",
                f"lightning-input-field:has-text('{label}') input",
            ]

            for sel in input_selectors:
                try:
                    loc = page.locator(sel)
                    if await loc.count() > 0:
                        input_loc = loc.first
                        print(f"[LOOKUP] → Input found via CSS: {sel}")
                        break
                except Exception:
                    continue

        if not input_loc:
            logger.warning(f"  ⚠ No lookup input found for '{label}'")
            return False

        try:
            # ─── Step 2: Type the search value ───
            await input_loc.scroll_into_view_if_needed(timeout=5000)
            await input_loc.click(timeout=5000)
            await asyncio.sleep(0.5)

            # Clear any existing value first
            await input_loc.fill("", timeout=3000)
            await asyncio.sleep(0.3)
            await input_loc.fill(value or "", timeout=5000)
            logger.info(f"  → Typed '{value}' into lookup input")

            # ─── Step 3: Check for suggestion dropdown with RETRIES ───
            suggestion_selectors = [
                f"lightning-base-combobox-formatted-text:has-text('{value}')",
                f"[role='option']:has-text('{value}')",
                f"lightning-base-combobox-item:has-text('{value}')",
                f".slds-listbox__option:has-text('{value}')",
                f"[data-value='{value}']",
            ]

            # Retry loop: suggestions may take 2-6s to appear (server-side search)
            for attempt in range(4):
                await asyncio.sleep(1.5)  # Wait between attempts
                logger.info(f"  → Checking suggestions (attempt {attempt + 1}/4)...")

                # Try Playwright selectors first
                for ss in suggestion_selectors:
                    try:
                        suggestion = page.locator(ss)
                        count = await suggestion.count()
                        if count > 0:
                            # Find a VISIBLE suggestion (skip hidden ones from other lookups)
                            for i in range(min(count, 5)):
                                s = suggestion.nth(i)
                                if await s.is_visible():
                                    await s.click(timeout=5000)
                                    logger.info(f"  ✅ Lookup '{label}' → clicked suggestion (attempt {attempt + 1})")
                                    await asyncio.sleep(1)

                                    # Smart verification: check if selection was accepted
                                    if await SalesforceLightningEngine._verify_lookup_selection(
                                        page, label, value, input_loc
                                    ):
                                        return True
                                    # If not verified, continue to next selector
                    except Exception:
                        continue

                # Try JS-based suggestion click (catches Shadow DOM cases)
                try:
                    clicked = await page.evaluate("""(args) => {
                        const [val] = args;
                        const valLower = val.toLowerCase();
                        // Search all visible listbox options
                        const options = document.querySelectorAll(
                            '[role="option"], lightning-base-combobox-item, .slds-listbox__option'
                        );
                        for (const opt of options) {
                            if (opt.offsetParent === null) continue; // skip hidden
                            const text = opt.textContent?.trim()?.toLowerCase() || '';
                            if (text.includes(valLower)) {
                                opt.scrollIntoView({ behavior: 'instant', block: 'center' });
                                opt.click();
                                return true;
                            }
                            // Also check title attribute on spans
                            const span = opt.querySelector('span[title], lightning-base-combobox-formatted-text');
                            if (span) {
                                const spanText = (span.getAttribute('title') || span.textContent || '').toLowerCase();
                                if (spanText.includes(valLower)) {
                                    opt.click();
                                    return true;
                                }
                            }
                        }
                        return false;
                    }""", [value])
                    if clicked:
                        logger.info(f"  ✅ Lookup '{label}' → JS click (attempt {attempt + 1})")
                        await asyncio.sleep(1)
                        if await SalesforceLightningEngine._verify_lookup_selection(
                            page, label, value, input_loc
                        ):
                            return True
                except Exception:
                    pass

                # On retry, ONLY clear and re-type if input still shows the typed text
                if attempt < 3:
                    try:
                        # Check if input still has the typed value (meaning nothing was selected)
                        try:
                            current_val = await input_loc.input_value(timeout=2000)
                        except Exception:
                            current_val = ""

                        if current_val and value.lower() in current_val.lower():
                            logger.info(f"  ℹ Input still shows typed text, re-typing...")
                            await input_loc.click(timeout=3000)
                            await input_loc.fill("", timeout=3000)
                            await asyncio.sleep(0.3)
                            await input_loc.fill(value or "", timeout=5000)
                        else:
                            # Value changed — selection may have worked
                            logger.info(f"  ✅ Lookup '{label}' → input value changed, assuming selection succeeded")
                            return True
                    except Exception:
                        pass

            print(f"[LOOKUP] ℹ No dropdown suggestions for '{value}' after 4 attempts, trying advanced search...")
            logger.info(f"  ℹ No dropdown suggestions for '{value}' after 4 attempts, trying advanced search...")

            # ─── Step 4: Advanced Search Fallback ───
            adv_result = await SalesforceLightningEngine._lookup_advanced_search(
                page, label, value, input_loc
            )
            if adv_result:
                # Verify pill after advanced search too
                if await SalesforceLightningEngine._verify_lookup_pill(page, label, value):
                    return True
                logger.info(f"  ⚠ Advanced search completed but no pill detected")
                return True  # Trust advanced search result even without pill
            return False

        except Exception as e:
            logger.warning(f"  ⚠ Lookup failed for '{label}': {e}")
            return False
    @staticmethod
    async def _verify_lookup_selection(page, label, value, input_loc):
        """Smart verification that a lookup selection was accepted.

        Checks multiple signals (any one = success):
        1. Pill element visible (lightning-pill)
        2. Input element hidden (Lightning hides input after selection)
        3. Input value changed/empty (selection cleared the typed text)
        4. A pill/link with the value text exists near the field
        """
        try:
            await asyncio.sleep(0.5)

            # Signal 1: Check for pill element
            pill_selectors = [
                f"lightning-input-field:has-text('{label}') lightning-pill",
                f"lightning-input-field:has-text('{label}') .slds-pill",
                f".slds-form-element:has-text('{label}') lightning-pill",
                f"lightning-grouped-combobox:has-text('{label}') lightning-pill",
            ]
            for ps in pill_selectors:
                try:
                    pill = page.locator(ps)
                    if await pill.count() > 0 and await pill.first.is_visible():
                        pill_text = await pill.first.text_content()
                        logger.info(f"  ✅ Pill verified for '{label}': '{pill_text}'")
                        return True
                except Exception:
                    continue

            # Signal 2: Input is now hidden (Lightning hides combobox after selection)
            try:
                if not await input_loc.is_visible():
                    logger.info(f"  ✅ Lookup input hidden after selection for '{label}'")
                    return True
            except Exception:
                pass

            # Signal 3: Input value changed from what we typed
            try:
                current_val = await input_loc.input_value(timeout=2000)
                if not current_val or (value.lower() not in current_val.lower()):
                    logger.info(f"  ✅ Lookup input value changed for '{label}' (now: '{current_val}')")
                    return True
            except Exception:
                # If we can't even read the input, it might be gone (replaced by pill)
                logger.info(f"  ✅ Lookup input not readable for '{label}' — likely replaced by pill")
                return True

            # Signal 4: Check for any element with the value near the field container
            try:
                container_check = page.locator(
                    f"lightning-input-field:has-text('{label}'):has-text('{value}')"
                )
                if await container_check.count() > 0:
                    logger.info(f"  ✅ Value '{value}' found in container for '{label}'")
                    return True
            except Exception:
                pass

            logger.info(f"  ℹ Lookup selection not confirmed for '{label}' — input still shows typed text")
            return False
        except Exception:
            return False

    @staticmethod
    async def _verify_lookup_pill(page, label, value):
        """Verify that a lookup pill element appeared after selection.

        Salesforce shows a pill (lightning-pill) with the selected record name
        after a successful lookup selection. If no pill appears, the selection
        likely failed.
        """
        try:
            # Wait briefly for pill to appear
            pill_selectors = [
                f"lightning-input-field:has-text('{label}') lightning-pill",
                f"lightning-input-field:has-text('{label}') .slds-pill",
                f".slds-form-element:has-text('{label}') lightning-pill",
                f".slds-form-element:has-text('{label}') .slds-pill",
                f"lightning-grouped-combobox:has-text('{label}') lightning-pill",
            ]

            for ps in pill_selectors:
                try:
                    pill = page.locator(ps)
                    # Wait up to 3s for pill to appear
                    await pill.first.wait_for(state="visible", timeout=3000)
                    pill_text = await pill.first.text_content()
                    logger.info(f"  ✅ Pill verified for '{label}': '{pill_text}'")
                    return True
                except Exception:
                    continue

            # Also check if the input field now has a value attribute or is hidden
            # (Salesforce hides the input and shows a pill after selection)
            try:
                input_check = page.locator(
                    f"lightning-input-field:has-text('{label}') input[role='combobox']"
                )
                if await input_check.count() > 0:
                    is_visible = await input_check.first.is_visible()
                    if not is_visible:
                        # Input hidden = pill is showing
                        logger.info(f"  ✅ Lookup input hidden (pill showing) for '{label}'")
                        return True
            except Exception:
                pass

            logger.info(f"  ℹ No pill detected for '{label}' — selection may not have completed")
            return False
        except Exception:
            return False


    @staticmethod
    async def _lookup_advanced_search(page, label, value, input_loc):
        """Handle Salesforce Advanced Search modal for lookup fields."""
        print(f"[LOOKUP-ADV] 🔎 Starting advanced search for '{label}' = '{value}'")

        # Count existing dialogs (edit form is already a dialog)
        existing_dialog_count = 0
        try:
            existing_dialog_count = await page.locator("div[role='dialog']").count()
            print(f"[LOOKUP-ADV] Existing dialogs: {existing_dialog_count}")
        except Exception:
            pass

        # ─── Try different search terms: full value, first word, shorter ───
        search_terms = [value]
        if ' ' in value:
            search_terms.append(value.split()[0])  # first word e.g. "HDFC"
        if len(value) > 4:
            search_terms.append(value[:4])  # first 4 chars

        for search_term in search_terms:
            print(f"[LOOKUP-ADV] Trying search term: '{search_term}'")

            # ─── Click the ORIGINAL input_loc to ensure correct focus ───
            try:
                await input_loc.scroll_into_view_if_needed(timeout=3000)
                await input_loc.click(timeout=3000)
                await asyncio.sleep(0.3)
            except Exception:
                # If input_loc is stale, try to re-find it via get_by_label
                try:
                    loc = page.get_by_label(label, exact=False)
                    if await loc.count() > 0:
                        input_loc = loc.first
                        await input_loc.click(timeout=3000)
                        print(f"[LOOKUP-ADV] → Re-found input via get_by_label")
                except Exception as e:
                    print(f"[LOOKUP-ADV] ⚠ Could not re-focus input: {e}")
                    continue

            # ─── Clear and type the search term ───
            try:
                await input_loc.fill("", timeout=3000)
                await asyncio.sleep(0.3)
            except Exception:
                try:
                    await input_loc.press("Control+a")
                    await input_loc.press("Backspace")
                except Exception:
                    pass

            try:
                # Type character by character to trigger autocomplete
                await page.keyboard.type(search_term, delay=150)
                await asyncio.sleep(3)
                print(f"[LOOKUP-ADV] → Typed '{search_term}' into focused input")
            except Exception as e:
                print(f"[LOOKUP-ADV] ⚠ Could not type: {e}")
                continue

            # ─── Check dropdown for matching option or "Search..." ───
            try:
                # Get all visible listbox options
                options = page.locator("[role='option']:visible, lightning-base-combobox-item:visible")
                opt_count = await options.count()
                opt_texts = []
                for oi in range(min(opt_count, 10)):
                    try:
                        txt = await options.nth(oi).text_content(timeout=1000)
                        opt_texts.append(txt.strip() if txt else "")
                    except Exception:
                        opt_texts.append("")
                print(f"[LOOKUP-ADV] Dropdown options ({opt_count}): {[t[:40] for t in opt_texts[:5]]}")

                # Try to find matching option
                for oi in range(opt_count):
                    opt = options.nth(oi)
                    if await opt.is_visible():
                        opt_text = opt_texts[oi].lower() if oi < len(opt_texts) else ""
                        if value.lower() in opt_text or (len(search_term) >= 3 and search_term.lower() in opt_text):
                            # Skip "New", "Search", and "+" options — only select ACTUAL records
                            if (opt_text.startswith("new ") or opt_text.startswith("+") or
                                    opt_text.startswith("search") or "show more results" in opt_text or
                                    "add" in opt_text[:4]):
                                continue
                            await opt.click(timeout=5000)
                            print(f"[LOOKUP-ADV] ✅ Selected from dropdown: '{opt_texts[oi][:40]}'")
                            return True

                # Try to find "Search..." option
                for oi in range(opt_count):
                    opt = options.nth(oi)
                    if await opt.is_visible():
                        opt_text = opt_texts[oi].lower() if oi < len(opt_texts) else ""
                        if 'search' in opt_text and 'new' not in opt_text:
                            await opt.click(timeout=5000)
                            print(f"[LOOKUP-ADV] → Clicked 'Search...' option")
                            await asyncio.sleep(3)
                            # Check for NEW dialog
                            new_count = await page.locator("div[role='dialog']").count()
                            if new_count > existing_dialog_count:
                                print(f"[LOOKUP-ADV] → NEW search modal opened ({new_count})")
                                search_modal = page.locator("div[role='dialog']").nth(new_count - 1)
                                result = await SalesforceLightningEngine._search_in_modal(page, search_modal, label, value)
                                if result:
                                    return True
                                # Modal search failed — close the modal before continuing
                                try:
                                    cancel_btn = search_modal.locator("button:has-text('Cancel')")
                                    if await cancel_btn.count() > 0:
                                        await cancel_btn.first.click(timeout=3000)
                                        print(f"[LOOKUP-ADV] → Closed search modal via Cancel")
                                    else:
                                        await page.keyboard.press("Escape")
                                    await asyncio.sleep(1)
                                except Exception:
                                    try:
                                        await page.keyboard.press("Escape")
                                        await asyncio.sleep(1)
                                    except Exception:
                                        pass
                                # Don't continue outer loop — modal search already tried shorter terms
                                return False
                            break

            except Exception as e:
                print(f"[LOOKUP-ADV] ⚠ Dropdown check error: {e}")

            # ─── Press Escape to close dropdown before next attempt ───
            try:
                await page.keyboard.press("Escape")
                await asyncio.sleep(0.5)
            except Exception:
                pass

        # ─── If all search terms failed, try clicking "Search..." text link ───
        # Some Salesforce orgs show "Search..." as a link at the bottom of dropdown
        try:
            await input_loc.click(timeout=3000)
            await asyncio.sleep(0.5)
            await input_loc.fill("", timeout=3000)
            await asyncio.sleep(0.3)
            await page.keyboard.type(value, delay=100)
            await asyncio.sleep(2)

            # Look for specific "Search..." text links
            search_links = page.locator(
                "lightning-base-combobox-item:has-text('Search'), "
                ".slds-listbox__option:has-text('Search'), "
                "span.slds-listbox__option-text:has-text('Search')"
            )
            if await search_links.count() > 0:
                for si in range(await search_links.count()):
                    if await search_links.nth(si).is_visible():
                        await search_links.nth(si).click(timeout=5000)
                        print(f"[LOOKUP-ADV] → Clicked Search link")
                        await asyncio.sleep(3)
                        new_count = await page.locator("div[role='dialog']").count()
                        if new_count > existing_dialog_count:
                            search_modal = page.locator("div[role='dialog']").nth(new_count - 1)
                            return await SalesforceLightningEngine._search_in_modal(page, search_modal, label, value)
                        break
        except Exception:
            pass

        print(f"[LOOKUP-ADV] ⚠ Advanced search could not select record for '{label}'")
        print(f"[LOOKUP-ADV] ℹ The record '{value}' may not exist in the '{label}' lookup object")
        return False

    @staticmethod
    async def _search_in_modal(page, modal, label, value):
        """Search for a record within a Salesforce search modal dialog."""
        print(f"[LOOKUP-MODAL] Searching for '{value}' in modal")

        # ─── First check if results are already loaded ───
        result_found = await SalesforceLightningEngine._click_modal_result(modal, value)
        if result_found:
            return True

        # ─── Build search terms: full value, first word, first 4 chars ───
        search_terms = [value]
        if ' ' in value:
            search_terms.append(value.split()[0])
        if len(value) > 4:
            search_terms.append(value[:4])

        for search_term in search_terms:
            # ─── Fill search input within THIS specific modal ───
            search_input = None
            for si in ["input[type='search']", "input[type='text']", "input.slds-input"]:
                try:
                    inp = modal.locator(si)
                    if await inp.count() > 0 and await inp.first.is_visible():
                        await inp.first.fill(search_term, timeout=5000)
                        search_input = inp.first
                        print(f"[LOOKUP-MODAL] → Filled search input with '{search_term}': {si}")
                        break
                except Exception:
                    continue

            if not search_input:
                print(f"[LOOKUP-MODAL] ⚠ No search input found in modal")
                try:
                    all_text = await modal.text_content(timeout=3000)
                    print(f"[LOOKUP-MODAL] Modal text: {all_text[:200] if all_text else '(empty)'}")
                except Exception:
                    pass
                return False

            # ─── Click Search button or press Enter ───
            btn_clicked = False
            for btn_sel in ["button:has-text('Search')", "button:has-text('Go')", "button[title='Search']"]:
                try:
                    btn = modal.locator(btn_sel)
                    if await btn.count() > 0 and await btn.first.is_visible():
                        await btn.first.click(timeout=5000)
                        print(f"[LOOKUP-MODAL] → Clicked: {btn_sel}")
                        btn_clicked = True
                        break
                except Exception:
                    continue

            if not btn_clicked:
                try:
                    await search_input.press("Enter")
                    print(f"[LOOKUP-MODAL] → Pressed Enter")
                except Exception:
                    pass

            await asyncio.sleep(5)

            # ─── Find and click matching result ───
            result_found = await SalesforceLightningEngine._click_modal_result(modal, value)
            if result_found:
                return True

            # ─── Check if "No results" — try next term ───
            try:
                modal_text = await modal.text_content(timeout=3000)
                if modal_text and "no results" in modal_text.lower():
                    print(f"[LOOKUP-MODAL] ⚠ No results for '{search_term}', trying shorter term...")
                    continue
            except Exception:
                pass

            # If we got here with results but no match, break
            break

        # Debug: show modal content
        try:
            all_text = await modal.text_content(timeout=3000)
            print(f"[LOOKUP-MODAL] Modal text: {all_text[:300] if all_text else '(empty)'}")
        except Exception:
            pass

        print(f"[LOOKUP-MODAL] ⚠ No matching record found")
        return False

    @staticmethod
    async def _click_modal_result(modal, value):
        """Try to find and click a matching result in a search modal."""
        result_selectors = [
            f"a:has-text('{value}')",
            f"th a:has-text('{value}')",
            f"td a:has-text('{value}')",
            f"[role='row'] a:has-text('{value}')",
            f"lightning-base-formatted-text:has-text('{value}')",
            f"td:has-text('{value}')",
            f"tr:has-text('{value}')",
            f"[role='row']:has-text('{value}')",
        ]

        for rs in result_selectors:
            try:
                result = modal.locator(rs)
                count = await result.count()
                if count > 0:
                    for i in range(min(count, 5)):
                        if await result.nth(i).is_visible():
                            await result.nth(i).click(timeout=5000)
                            print(f"[LOOKUP-MODAL] → Clicked result: {rs} (item {i})")
                            await asyncio.sleep(1)
                            
                            # Try clicking Select button (if present)
                            try:
                                select_btn = modal.locator("button:has-text('Select')")
                                if await select_btn.count() > 0 and await select_btn.first.is_visible():
                                    await select_btn.first.click(timeout=3000)
                                    print(f"[LOOKUP-MODAL] ✅ Clicked Select button")
                            except Exception:
                                pass
                            
                            # Check if modal closed (record was selected via link click)
                            await asyncio.sleep(0.5)
                            print(f"[LOOKUP-MODAL] ✅ Record selected")
                            return True
            except Exception:
                continue
        
        return False



    @staticmethod
    async def _fill_generic(page, label, value):
        """Generic fill: try Lightning component selectors, then standard fill."""
        selectors = [
            f"lightning-input-field:has-text('{label}') input",
            f"lightning-input:has-text('{label}') input",
            f"lightning-textarea:has-text('{label}') textarea",
            f"input[aria-label='{label}']",
            f"input[name='{label}']",
            f"textarea[name='{label}']",
        ]
        for sel in selectors:
            try:
                loc = page.locator(sel)
                if await loc.count() == 0:
                    continue
                el = loc.first
                await el.scroll_into_view_if_needed(timeout=5000)
                await el.click(timeout=5000)
                await el.fill(value or "", timeout=10000)
                await page.keyboard.press("Tab")
                await asyncio.sleep(0.3)
                logger.info(f"  → Generic fill '{label}' via {sel}")
                return True
            except Exception as e:
                logger.debug(f"  Generic {sel} failed: {e}")
                continue

        # Try resolve_locator + fill
        try:
            loc = await SalesforceLightningEngine._resolve_label(page, label)
            await loc.wait_for(state="attached", timeout=15000)
            try:
                await loc.scroll_into_view_if_needed(timeout=5000)
            except Exception:
                pass
            await loc.wait_for(state="visible", timeout=15000)
            await loc.click(timeout=5000)
            await loc.fill(value or "", timeout=10000)
            await page.keyboard.press("Tab")
            await asyncio.sleep(0.3)
            logger.info(f"  → Generic fill '{label}' via _resolve_label")
            return True
        except Exception as e:
            logger.debug(f"  Generic _resolve_label fill failed: {e}")

        # Try click + type fallback
        try:
            loc = await SalesforceLightningEngine._resolve_label(page, label)
            await loc.wait_for(state="visible", timeout=10000)
            await loc.click(timeout=5000)
            await loc.press("Control+A")
            await loc.type(value or "", delay=50)
            await page.keyboard.press("Tab")
            await asyncio.sleep(0.3)
            logger.info(f"  → Generic fill '{label}' via click+type")
            return True
        except Exception as e:
            logger.debug(f"  Generic click+type failed: {e}")

        return False

    @staticmethod
    async def _fill_via_js(page, label, value):
        """Last resort: find the field via JS DOM traversal and set value."""
        try:
            found = await page.evaluate("""(args) => {
                const [labelText, fillValue] = args;
                const root = document.querySelector(
                    '.slds-modal__content, records-record-edit-form'
                ) || document.body;

                // Find all label/span elements containing our text
                const labelEls = root.querySelectorAll(
                    'label, span.slds-form-element__label, legend, .test-id__field-label'
                );
                for (const lbl of labelEls) {
                    if (!lbl.textContent || !lbl.textContent.trim().includes(labelText)) continue;

                    // Walk up to the form element container
                    const container = lbl.closest(
                        'lightning-input-field, lightning-datepicker, lightning-input, ' +
                        'lightning-combobox, lightning-textarea, .slds-form-element'
                    );
                    if (!container) continue;

                    const input = container.querySelector(
                        'input:not([type=hidden]):not([type=file]), textarea'
                    );
                    if (!input) continue;

                    // Scroll into view
                    input.scrollIntoView({ behavior: 'instant', block: 'center' });

                    // Set value via native setter (triggers Lightning data binding)
                    const proto = input.tagName === 'TEXTAREA'
                        ? HTMLTextAreaElement.prototype
                        : HTMLInputElement.prototype;
                    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                    setter.call(input, fillValue);
                    input.dispatchEvent(new Event('focus', { bubbles: true }));
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new Event('blur', { bubbles: true }));
                    return true;
                }
                return false;
            }""", [label, value or ""])

            if found:
                await page.keyboard.press("Tab")
                await asyncio.sleep(0.5)
                logger.info(f"  → Filled '{label}' via JS DOM traversal")
                return True
        except Exception as e:
            logger.debug(f"  JS DOM traversal failed for '{label}': {e}")
        return False
