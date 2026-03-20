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
                    if (field.querySelector('input[type="checkbox"], lightning-primitive-input-toggle')) {
                        map[labelText] = 'checkbox';
                    } else if (field.querySelector('lightning-datepicker')) {
                        map[labelText] = 'date';
                    } else if (field.querySelector('lightning-timepicker')) {
                        map[labelText] = 'time';
                    } else if (field.querySelector('lightning-dual-listbox')) {
                        map[labelText] = 'multipicklist';
                    } else if (field.querySelector('lightning-combobox')) {
                        map[labelText] = 'picklist';
                    } else if (field.querySelector('lightning-lookup, lightning-grouped-combobox, input[role="combobox"]')) {
                        map[labelText] = 'lookup';
                    } else if (field.querySelector('lightning-input-rich-text, [contenteditable="true"]')) {
                        map[labelText] = 'richtext';
                    } else if (field.querySelector('lightning-textarea, textarea')) {
                        map[labelText] = 'textarea';
                    } else if (field.querySelector('input[type="file"], lightning-file-upload')) {
                        map[labelText] = 'file';
                    } else {
                        map[labelText] = 'text';
                    }
                });

                // Scan standalone lightning-input, lightning-combobox, lightning-datepicker
                ['lightning-input', 'lightning-combobox', 'lightning-datepicker',
                 'lightning-timepicker', 'lightning-textarea', 'lightning-lookup',
                 'lightning-dual-listbox', 'lightning-input-rich-text',
                 'lightning-file-upload'].forEach(tag => {
                    modal.querySelectorAll(tag).forEach(el => {
                        const label = el.querySelector('label, .slds-form-element__label');
                        if (!label) return;
                        const labelText = label.textContent.trim();
                        if (!labelText || map[labelText]) return;

                        if (tag === 'lightning-datepicker') map[labelText] = 'date';
                        else if (tag === 'lightning-timepicker') map[labelText] = 'time';
                        else if (tag === 'lightning-combobox') map[labelText] = 'picklist';
                        else if (tag === 'lightning-lookup') map[labelText] = 'lookup';
                        else if (tag === 'lightning-textarea') map[labelText] = 'textarea';
                        else if (tag === 'lightning-dual-listbox') map[labelText] = 'multipicklist';
                        else if (tag === 'lightning-input-rich-text') map[labelText] = 'richtext';
                        else if (tag === 'lightning-file-upload') map[labelText] = 'file';
                        else map[labelText] = 'text';
                    });
                });

                // Scan .slds-form-element containers as fallback
                modal.querySelectorAll('.slds-form-element').forEach(el => {
                    const label = el.querySelector('label, .slds-form-element__label, legend');
                    if (!label) return;
                    const labelText = label.textContent.trim();
                    if (!labelText || map[labelText]) return;

                    if (el.querySelector('input[type="checkbox"], lightning-primitive-input-toggle')) {
                        map[labelText] = 'checkbox';
                    } else if (el.querySelector('input[type="date"], lightning-datepicker')) {
                        map[labelText] = 'date';
                    } else if (el.querySelector('lightning-timepicker')) {
                        map[labelText] = 'time';
                    } else if (el.querySelector('lightning-dual-listbox')) {
                        map[labelText] = 'multipicklist';
                    } else if (el.querySelector('select, lightning-combobox, [role="listbox"]')) {
                        map[labelText] = 'picklist';
                    } else if (el.querySelector('input[role="combobox"]')) {
                        map[labelText] = 'lookup';
                    } else if (el.querySelector('lightning-input-rich-text, [contenteditable="true"]')) {
                        map[labelText] = 'richtext';
                    } else if (el.querySelector('textarea')) {
                        map[labelText] = 'textarea';
                    } else if (el.querySelector('input[type="file"], lightning-file-upload')) {
                        map[labelText] = 'file';
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
                    "multipicklist": "multipicklist",
                    "combobox": "picklist",
                    "reference": "lookup",
                    "date": "date",
                    "datetime": "date",
                    "boolean": "checkbox",
                    "time": "time",
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
        if field_type == "checkbox":
            success = await SalesforceLightningEngine._fill_checkbox(page, label, value)
            if success:
                return
        elif field_type == "multipicklist":
            success = await SalesforceLightningEngine._fill_multi_picklist(page, label, value)
            if success:
                return
        elif field_type == "richtext":
            success = await SalesforceLightningEngine._fill_rich_text(page, label, value)
            if success:
                return
        elif field_type == "time":
            success = await SalesforceLightningEngine._fill_time(page, label, value)
            if success:
                return
        elif field_type == "date":
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
        # IMPORTANT: Must find input inside a lightning-lookup/lightning-grouped-combobox,
        # NOT a picklist input that happens to share the same label text.
        input_loc = None

        # Priority 1: Lookup-specific CSS selectors (most precise — scoped to lookup components)
        lookup_input_selectors = [
            # lightning-lookup component hierarchy
            f"lightning-lookup:has-text('{label}') input[role='combobox']",
            f"lightning-lookup:has-text('{label}') input",
            # lightning-grouped-combobox (Salesforce uses this for lookups)
            f"lightning-grouped-combobox:has-text('{label}') input[role='combobox']",
            f"lightning-grouped-combobox:has-text('{label}') input",
            # lightning-input-field containing a lookup (has combobox role)
            f"lightning-input-field:has-text('{label}') input[role='combobox']",
            # slds-form-element scoped to combobox (excludes picklist selects)
            f".slds-form-element:has-text('{label}') input[role='combobox']",
        ]

        for sel in lookup_input_selectors:
            try:
                loc = page.locator(sel)
                cnt = await loc.count()
                if cnt > 0:
                    # Pick the first visible one
                    for i in range(min(cnt, 3)):
                        candidate = loc.nth(i)
                        if await candidate.is_visible():
                            input_loc = candidate
                            print(f"[LOOKUP] → Input found via CSS: {sel}")
                            break
                if input_loc:
                    break
            except Exception:
                continue

        # Priority 2: get_by_label with parent validation — verify it's inside a lookup component
        if not input_loc:
            try:
                loc = page.get_by_label(label, exact=False)
                cnt = await loc.count()
                for i in range(min(cnt, 5)):
                    candidate = loc.nth(i)
                    try:
                        tag = await candidate.evaluate("el => el.tagName.toLowerCase()")
                        if tag != 'input':
                            continue
                        # Validate it's inside a lightning-lookup or lightning-grouped-combobox
                        is_lookup = await candidate.evaluate("""el => {
                            let p = el.parentElement;
                            while (p) {
                                const tag = p.tagName.toLowerCase();
                                if (tag === 'lightning-lookup' || tag === 'lightning-grouped-combobox') return true;
                                if (tag === 'lightning-picklist' || tag === 'select') return false;
                                p = p.parentElement;
                            }
                            return false;
                        }""")
                        if is_lookup:
                            input_loc = candidate
                            print(f"[LOOKUP] → Input found via get_by_label (parent-validated) for '{label}'")
                            break
                    except Exception:
                        continue
            except Exception:
                pass

        # Priority 3: JS parent-walk — find any visible combobox input near label text
        if not input_loc:
            try:
                handle = await page.evaluate_handle("""(lbl) => {
                    // Find all label elements containing the text
                    const allLabels = Array.from(document.querySelectorAll('label, span.slds-form-element__label'));
                    for (const labelEl of allLabels) {
                        if (!labelEl.textContent.trim().toLowerCase().includes(lbl.toLowerCase())) continue;
                        // Walk up to find a sibling/descendant combobox input inside a lookup element
                        let parent = labelEl.parentElement;
                        for (let depth = 0; depth < 8 && parent; depth++) {
                            const tag = parent.tagName.toLowerCase();
                            if (tag === 'lightning-lookup' || tag === 'lightning-grouped-combobox' || tag === 'lightning-input-field') {
                                const inp = parent.querySelector('input[role="combobox"], input[type="text"]');
                                if (inp && inp.offsetParent !== null) return inp;
                            }
                            parent = parent.parentElement;
                        }
                    }
                    return null;
                }""", label)
                el = handle.as_element()
                if el:
                    input_loc = page.locator("xpath=//input[@role='combobox']").first  # placeholder
                    # Use JS click/type directly since we have the element handle
                    print(f"[LOOKUP] → Input found via JS parent-walk for '{label}'")
                    # Use JS-based interaction instead
                    await el.scroll_into_view_if_needed()
                    await el.click()
                    await asyncio.sleep(0.4)
                    await el.evaluate("inp => { inp.value = ''; }")
                    search_str = value[:3] if len(value) > 3 else value
                    await el.type(search_str, delay=80)
                    logger.info(f"  → Typed '{search_str}' (JS path) into lookup '{label}'")
                    # Check dropdown the same way
                    await asyncio.sleep(2)
                    # JS-click the option
                    picked = await page.evaluate("""(args) => {
                        const [val] = args;
                        const vLow = val.toLowerCase();
                        const opts = document.querySelectorAll('[role="listbox"] [role="option"], lightning-base-combobox-item, .slds-listbox__option');
                        for (const o of opts) {
                            if (o.offsetParent === null) continue;
                            const t = (o.textContent || '').toLowerCase();
                            if (t.includes(vLow.substring(0, 3))) { o.click(); return o.textContent.trim(); }
                        }
                        return null;
                    }""", [value])
                    if picked:
                        logger.info(f"  ✅ Lookup '{label}' → JS path clicked: '{picked}'")
                        await asyncio.sleep(1)
                        return True
                    # Fallback: advanced search
                    input_loc = None  # Will fall through to advanced search below
            except Exception as _e:
                print(f"[LOOKUP] JS parent-walk error: {_e}")

        if not input_loc:
            logger.warning(f"  ⚠ No lookup input found for '{label}'")
            return False


        try:
            # ─── Step 2: Type the search value ───
            # Salesforce LWC lookup components require real InputEvent dispatches
            # with composed:true to cross Shadow DOM. Simple typing methods often
            # fail to trigger the autocomplete AJAX.
            await input_loc.scroll_into_view_if_needed(timeout=5000)
            await input_loc.click(timeout=5000)
            await asyncio.sleep(0.5)

            # Clear existing value
            await input_loc.fill("", timeout=3000)
            await asyncio.sleep(0.3)

            # Strategy A: Use JS to set value + dispatch InputEvent with composed:true
            # This is the React/LWC-compatible method
            search_str = value[:3] if len(value) > 3 else value
            js_typed = await input_loc.evaluate("""(inp, searchStr) => {
                // Focus the input
                inp.focus();
                // Use the native setter to bypass any LWC property override
                const nativeSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                ).set;
                // Clear first
                nativeSetter.call(inp, '');
                inp.dispatchEvent(new InputEvent('input', {
                    bubbles: true, composed: true, inputType: 'deleteContentBackward'
                }));
                // Type char by char with events
                let typed = '';
                for (const ch of searchStr) {
                    typed += ch;
                    nativeSetter.call(inp, typed);
                    inp.dispatchEvent(new InputEvent('input', {
                        bubbles: true, composed: true, data: ch, inputType: 'insertText'
                    }));
                    inp.dispatchEvent(new KeyboardEvent('keydown', {
                        bubbles: true, composed: true, key: ch, code: 'Key' + ch.toUpperCase()
                    }));
                    inp.dispatchEvent(new KeyboardEvent('keyup', {
                        bubbles: true, composed: true, key: ch, code: 'Key' + ch.toUpperCase()
                    }));
                }
                // Also fire change event
                inp.dispatchEvent(new Event('change', {bubbles: true, composed: true}));
                return inp.value;
            }""", search_str)
            print(f"[LOOKUP] → JS nativeInputValueSetter typed '{js_typed}' into lookup '{label}'")

            # Wait for Salesforce AJAX autocomplete
            await asyncio.sleep(2.5)

            # ─── DEBUG: Dump ALL visible options on the page ───
            debug_opts = await page.evaluate("""() => {
                const results = [];
                const listboxes = document.querySelectorAll('[role="listbox"]');
                for (const lb of listboxes) {
                    const opts = lb.querySelectorAll('[role="option"]');
                    const visibleOpts = [];
                    for (const o of opts) {
                        if (o.offsetParent !== null) {
                            visibleOpts.push((o.textContent || '').trim().substring(0, 60));
                        }
                    }
                    if (visibleOpts.length > 0) {
                        let parentTag = 'unknown';
                        let p = lb.parentElement;
                        for (let i = 0; i < 10 && p; i++) {
                            const t = p.tagName.toLowerCase();
                            if (t.startsWith('lightning-') || t.startsWith('c-')) { parentTag = t; break; }
                            p = p.parentElement;
                        }
                        results.push({parent: parentTag, count: visibleOpts.length, options: visibleOpts.slice(0, 8)});
                    }
                }
                return results;
            }""")
            print(f"[LOOKUP] DEBUG visible listboxes after JS type: {debug_opts}")

            # Check input value
            try:
                input_val = await input_loc.input_value(timeout=2000)
                print(f"[LOOKUP] DEBUG input value: '{input_val}'")
            except Exception:
                pass

            # ─── Step 3: Check dropdown options and click Search if needed ───
            # Playwright locators pierce Shadow DOM; JS evaluate does NOT.
            # So we use Playwright locators to find options, then JS click to bypass interception.

            # First, click the input to open/refresh the dropdown
            try:
                await input_loc.click(timeout=3000)
                await asyncio.sleep(1.5)
            except Exception:
                pass

            # Use Playwright locators (which pierce Shadow DOM) to find options
            # in the lookup component
            scoped_option_selectors = [
                f"lightning-lookup:has-text('{label}') [role='option']",
                f"lightning-grouped-combobox:has-text('{label}') [role='option']",
                f"lightning-input-field:has-text('{label}') [role='option']",
            ]

            found_options = []
            option_locator = None
            for sel in scoped_option_selectors:
                try:
                    loc = page.locator(sel)
                    count = await loc.count()
                    if count > 0:
                        option_locator = loc
                        for i in range(min(count, 10)):
                            try:
                                text = (await loc.nth(i).text_content(timeout=2000) or "").strip()
                                found_options.append(text)
                            except Exception:
                                found_options.append("")
                        print(f"[LOOKUP] Found {count} options via Playwright: {sel}")
                        print(f"[LOOKUP] Option texts: {[t[:50] for t in found_options]}")
                        break
                except Exception:
                    continue

            if not found_options:
                # Also try global visible options
                try:
                    all_opts = page.locator("[role='option']:visible")
                    count = await all_opts.count()
                    if count > 0:
                        for i in range(min(count, 10)):
                            text = (await all_opts.nth(i).text_content(timeout=2000) or "").strip()
                            found_options.append(text)
                        option_locator = all_opts
                        print(f"[LOOKUP] Found {count} global visible options: {[t[:50] for t in found_options]}")
                except Exception:
                    pass

            # Check if any option is a direct match for our value
            val_lower = value.lower()
            for i, text in enumerate(found_options):
                text_lower = text.lower()
                # Skip meta-options
                if any(skip in text_lower for skip in ['search', 'new ', 'add', 'show more', 'draft', 'finalized', 'sent', 'paid']):
                    continue
                if val_lower in text_lower or text_lower in val_lower:
                    try:
                        # Use JS click to bypass interception
                        await option_locator.nth(i).evaluate("el => el.click()")
                        print(f"[LOOKUP] ✅ Direct match clicked via JS: '{text}'")
                        await asyncio.sleep(1.0)
                        return True
                    except Exception as e:
                        print(f"[LOOKUP] ⚠ Failed to click match: {e}")

            # No direct match — find and click "Search..." / "Show more results"
            print(f"[LOOKUP] No direct match, looking for Search option...")
            for i, text in enumerate(found_options):
                text_lower = text.lower()
                if 'search' in text_lower or 'show more' in text_lower:
                    try:
                        # JS click to bypass click interception/timeout
                        await option_locator.nth(i).evaluate("el => el.click()")
                        print(f"[LOOKUP] → JS-clicked Search option: '{text[:50]}'")
                        await asyncio.sleep(3.0)

                        # A search modal should now be open
                        dialog_count = await page.locator("div[role='dialog']").count()
                        print(f"[LOOKUP] Dialog count after Search click: {dialog_count}")

                        # Find search input in the newest dialog
                        search_modal_input = None
                        modal_input_selectors = [
                            "div[role='dialog'] input[type='search']",
                            "div[role='dialog'] input[placeholder*='Search']",
                            "div[role='dialog'] input.slds-input",
                            "div[role='dialog'] input[role='combobox']",
                            "div[role='dialog'] input[type='text']",
                            "section[role='dialog'] input",
                        ]
                        for msel in modal_input_selectors:
                            try:
                                loc = page.locator(msel)
                                if await loc.count() > 0:
                                    for idx in range(await loc.count()):
                                        candidate = loc.nth(idx)
                                        if await candidate.is_visible():
                                            search_modal_input = candidate
                                            print(f"[LOOKUP] → Found search modal input: {msel}")
                                            break
                                if search_modal_input:
                                    break
                            except Exception:
                                continue

                        if search_modal_input:
                            # Wait for modal to finish initial load/search
                            await asyncio.sleep(1.5)

                            # Clear the pre-filled search text (from dropdown typing)
                            await search_modal_input.click(timeout=3000)
                            await asyncio.sleep(0.3)
                            await search_modal_input.fill("", timeout=3000)
                            await asyncio.sleep(0.5)

                            # Type the full value
                            await search_modal_input.fill(value, timeout=5000)
                            print(f"[LOOKUP] → Filled search modal with: '{value}'")
                            await asyncio.sleep(0.5)

                            # Press Enter to trigger search
                            await page.keyboard.press("Enter")
                            print(f"[LOOKUP] → Pressed Enter in search modal")
                            await asyncio.sleep(4.0)

                            # Debug: dump what's visible in the modal
                            try:
                                modal_html = await page.evaluate("""() => {
                                    const dialogs = document.querySelectorAll('div[role="dialog"]');
                                    const last = dialogs[dialogs.length - 1];
                                    if (!last) return 'no dialog';
                                    // Get all links and text in the dialog
                                    const links = last.querySelectorAll('a');
                                    const texts = [];
                                    for (const l of links) {
                                        if (l.offsetParent !== null) {
                                            texts.push(l.textContent.trim().substring(0, 60));
                                        }
                                    }
                                    // Also check table rows
                                    const rows = last.querySelectorAll('tr, [role="row"]');
                                    for (const r of rows) {
                                        if (r.offsetParent !== null) {
                                            texts.push('ROW:' + r.textContent.trim().substring(0, 60));
                                        }
                                    }
                                    // Check for "no results" message
                                    const bodyText = last.textContent || '';
                                    if (bodyText.includes('No results')) {
                                        texts.push('NO_RESULTS: ' + bodyText.substring(bodyText.indexOf('No results'), bodyText.indexOf('No results') + 40));
                                    }
                                    return texts.slice(0, 10);
                                }""")
                                print(f"[LOOKUP] DEBUG search modal contents: {modal_html}")
                            except Exception:
                                pass

                            # Look for result in modal
                            result_selectors = [
                                f"div[role='dialog'] a:has-text('{value}')",
                                f"div[role='dialog'] th a:has-text('{value[:10]}')",
                                f"div[role='dialog'] tr:has-text('{value}')",
                                f"div[role='dialog'] .slds-truncate:has-text('{value}')",
                                f"section[role='dialog'] a:has-text('{value}')",
                                # Partial match
                                f"div[role='dialog'] a:has-text('{value.split()[0]}')",
                            ]
                            for rsel in result_selectors:
                                try:
                                    result_loc = page.locator(rsel).first
                                    if await result_loc.is_visible():
                                        await result_loc.click(timeout=5000)
                                        print(f"[LOOKUP] ✅ Selected from search modal: {rsel}")
                                        await asyncio.sleep(1.5)
                                        return True
                                except Exception:
                                    continue

                            print(f"[LOOKUP] ⚠ No matching result in search modal")
                        else:
                            print(f"[LOOKUP] ⚠ No search input found in modal")
                    except Exception as e:
                        print(f"[LOOKUP] ⚠ Error clicking Search option: {e}")
                    break

            print(f"[LOOKUP] Falling through to advanced search fallback...")


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
                            # Use JS click to bypass interception/timeout
                            await opt.evaluate("el => el.click()")
                            print(f"[LOOKUP-ADV] ✅ Selected from dropdown: '{opt_texts[oi][:40]}'")
                            return True

                # Try to find "Search..." option
                for oi in range(opt_count):
                    opt = options.nth(oi)
                    if await opt.is_visible():
                        opt_text = opt_texts[oi].lower() if oi < len(opt_texts) else ""
                        if 'search' in opt_text and 'new' not in opt_text:
                            # Use JS click to bypass interception/timeout
                            await opt.evaluate("el => el.click()")
                            print(f"[LOOKUP-ADV] → Clicked 'Search...' option via JS")
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

    # ─────────────────────────────────────────────
    # A1: Checkbox / Toggle Field Handler
    # ─────────────────────────────────────────────

    @staticmethod
    async def _fill_checkbox(page, label, value):
        """Fill a Lightning checkbox or toggle field.

        Salesforce checkboxes render as:
        - lightning-input-field > input[type=checkbox]
        - lightning-input[type=toggle]
        - lightning-primitive-input-toggle
        - Standard <input type="checkbox">

        Strategy: Find the checkbox, check its current state, toggle if needed.
        Value: 'true'/'yes'/'1'/'checked' → check it; otherwise → uncheck it.
        """
        logger.info(f"  ☑ Checkbox: '{label}' → '{value}'")
        target_checked = value.lower().strip() in ("true", "yes", "1", "checked", "on")

        # Strategy 1: Lightning component selectors
        checkbox_selectors = [
            f"lightning-input-field:has-text('{label}') input[type='checkbox']",
            f"lightning-input:has-text('{label}') input[type='checkbox']",
            f".slds-form-element:has-text('{label}') input[type='checkbox']",
            f"lightning-input:has-text('{label}') span.slds-checkbox_faux",
            f"lightning-input:has-text('{label}') label.slds-checkbox__label",
            f"input[aria-label='{label}'][type='checkbox']",
        ]
        for sel in checkbox_selectors:
            try:
                loc = page.locator(sel)
                if await loc.count() == 0:
                    continue
                el = loc.first
                await el.scroll_into_view_if_needed(timeout=5000)

                # For actual input[type=checkbox], check the current state
                tag = await el.evaluate("el => el.tagName.toLowerCase()")
                if tag == "input":
                    is_checked = await el.is_checked()
                    if is_checked != target_checked:
                        # Click on the visual checkbox (span.slds-checkbox_faux or label)
                        # because clicking the hidden input may not work in Lightning
                        parent = page.locator(
                            f"lightning-input-field:has-text('{label}'), "
                            f"lightning-input:has-text('{label}'), "
                            f".slds-form-element:has-text('{label}')"
                        )
                        if await parent.count() > 0:
                            faux = parent.first.locator(
                                "span.slds-checkbox_faux, label.slds-checkbox__label, "
                                "span.slds-checkbox_on, span.slds-checkbox--faux"
                            )
                            if await faux.count() > 0:
                                await faux.first.click(timeout=5000)
                            else:
                                await el.click(timeout=5000)
                        else:
                            await el.click(timeout=5000)
                        await asyncio.sleep(0.3)
                        logger.info(f"  → Checkbox '{label}' toggled to {target_checked}")
                    else:
                        logger.info(f"  → Checkbox '{label}' already {target_checked}, skipping")
                else:
                    # For non-input elements (faux checkbox, label), just click
                    await el.click(timeout=5000)
                    await asyncio.sleep(0.3)
                    logger.info(f"  → Checkbox '{label}' clicked via {sel}")
                return True
            except Exception as e:
                logger.debug(f"  Checkbox strategy {sel} failed: {e}")
                continue

        # Strategy 2: Toggle switch components
        toggle_selectors = [
            f"lightning-input-field:has-text('{label}') lightning-primitive-input-toggle",
            f"lightning-input:has-text('{label}') button[role='switch']",
            f".slds-form-element:has-text('{label}') button[role='switch']",
        ]
        for sel in toggle_selectors:
            try:
                loc = page.locator(sel)
                if await loc.count() > 0:
                    el = loc.first
                    # Check current state via aria-checked
                    is_checked_str = await el.get_attribute("aria-checked") or "false"
                    is_checked = is_checked_str.lower() == "true"
                    if is_checked != target_checked:
                        await el.click(timeout=5000)
                        await asyncio.sleep(0.3)
                        logger.info(f"  → Toggle '{label}' switched to {target_checked}")
                    else:
                        logger.info(f"  → Toggle '{label}' already {target_checked}")
                    return True
            except Exception as e:
                logger.debug(f"  Toggle strategy {sel} failed: {e}")
                continue

        # Strategy 3: JS fallback
        try:
            toggled = await page.evaluate("""(args) => {
                const [labelText, shouldCheck] = args;
                const root = document.querySelector(
                    '.slds-modal__content, records-record-edit-form'
                ) || document.body;
                const labels = root.querySelectorAll(
                    'label, span.slds-form-element__label, legend'
                );
                for (const lbl of labels) {
                    if (!lbl.textContent || !lbl.textContent.trim().includes(labelText)) continue;
                    const container = lbl.closest(
                        'lightning-input-field, lightning-input, .slds-form-element'
                    );
                    if (!container) continue;
                    const cb = container.querySelector('input[type="checkbox"]');
                    if (cb) {
                        if (cb.checked !== shouldCheck) {
                            cb.click();
                        }
                        return true;
                    }
                    const toggle = container.querySelector('button[role="switch"]');
                    if (toggle) {
                        const isOn = toggle.getAttribute('aria-checked') === 'true';
                        if (isOn !== shouldCheck) {
                            toggle.click();
                        }
                        return true;
                    }
                }
                return false;
            }""", [label, target_checked])
            if toggled:
                await asyncio.sleep(0.3)
                logger.info(f"  → Checkbox '{label}' toggled via JS")
                return True
        except Exception as e:
            logger.debug(f"  Checkbox JS fallback failed: {e}")

        return False

    # ─────────────────────────────────────────────
    # A2: Multi-Select Picklist Handler
    # ─────────────────────────────────────────────

    @staticmethod
    async def _fill_multi_picklist(page, label, value):
        """Fill a Lightning Multi-Select Picklist (Dual Listbox).

        Salesforce multi-select picklists render as lightning-dual-listbox
        with two list columns: Available Options and Selected Options.

        Strategy:
        1. Find the dual-listbox component by label
        2. For each value to select, click it in the Available list
        3. Click the 'move to selected' arrow button

        Value format: semicolon-separated (e.g., "Value1;Value2;Value3")
        """
        logger.info(f"  ☰ Multi-Select Picklist: '{label}' → '{value}'")
        values = [v.strip() for v in (value or "").split(";") if v.strip()]
        if not values:
            return False

        # Strategy 1: Lightning dual-listbox component
        dual_listbox_selectors = [
            f"lightning-dual-listbox:has-text('{label}')",
            f"lightning-input-field:has-text('{label}') lightning-dual-listbox",
            f".slds-form-element:has-text('{label}') lightning-dual-listbox",
            f".slds-dueling-list:has-text('{label}')",
        ]

        for dl_sel in dual_listbox_selectors:
            try:
                container = page.locator(dl_sel)
                if await container.count() == 0:
                    continue

                container = container.first
                logger.info(f"  → Found dual-listbox via: {dl_sel}")

                selected_count = 0
                for val in values:
                    # Find the option in the Available list
                    option_selectors = [
                        f"[role='option']:has-text('{val}')",
                        f".slds-listbox__item:has-text('{val}')",
                        f"span[title='{val}']",
                    ]
                    for opt_sel in option_selectors:
                        try:
                            option = container.locator(opt_sel)
                            if await option.count() > 0:
                                await option.first.click(timeout=5000)
                                selected_count += 1
                                logger.info(f"  → Selected '{val}' in dual-listbox")
                                await asyncio.sleep(0.3)
                                break
                        except Exception:
                            continue

                # Click the "Move to Selected" arrow button
                if selected_count > 0:
                    move_right_selectors = [
                        "button[title='Move selection to Chosen']",
                        "button.slds-button:has(lightning-primitive-icon)",
                        "button[aria-label*='Move']",
                        "button[aria-label*='right']",
                    ]
                    for mr_sel in move_right_selectors:
                        try:
                            move_btn = container.locator(mr_sel)
                            if await move_btn.count() > 0:
                                await move_btn.first.click(timeout=5000)
                                await asyncio.sleep(0.5)
                                logger.info(f"  → Moved {selected_count} items to Selected")
                                return True
                        except Exception:
                            continue

                    # Alternative: some dual listboxes auto-move on double-click
                    logger.info(f"  → {selected_count} items selected but no move button found")
                    return True
            except Exception as e:
                logger.debug(f"  Dual-listbox {dl_sel} error: {e}")
                continue

        # Strategy 2: Multi-select combobox (non-dual-listbox)
        # Some SF fields use a combobox that allows multiple selections via checkboxes
        try:
            combo_selectors = [
                f"lightning-input-field:has-text('{label}') button",
                f".slds-form-element:has-text('{label}') button[aria-haspopup='listbox']",
            ]
            for cs in combo_selectors:
                trigger = page.locator(cs)
                if await trigger.count() == 0:
                    continue

                # Click to open the dropdown
                await trigger.first.click(timeout=5000)
                await asyncio.sleep(1)

                # Select each value
                for val in values:
                    option = page.locator(
                        f"[role='option']:has-text('{val}'), "
                        f"lightning-base-combobox-item:has-text('{val}')"
                    )
                    if await option.count() > 0:
                        await option.first.click(timeout=5000)
                        await asyncio.sleep(0.3)
                        logger.info(f"  → Multi-select: clicked '{val}'")

                # Close dropdown
                await page.keyboard.press("Escape")
                await asyncio.sleep(0.3)
                logger.info(f"  → Multi-select picklist '{label}' completed")
                return True
        except Exception as e:
            logger.debug(f"  Multi-select combobox fallback failed: {e}")

        return False

    # ─────────────────────────────────────────────
    # A3: Rich Text / HTML Editor Handler
    # ─────────────────────────────────────────────

    @staticmethod
    async def _fill_rich_text(page, label, value):
        """Fill a Lightning Rich Text editor field.

        Salesforce rich text fields use lightning-input-rich-text which wraps
        a contenteditable div or an iframe-based editor.

        Strategy:
        1. Find the editor container by label
        2. Click on the contenteditable area
        3. Type the value
        """
        logger.info(f"  📝 Rich Text: '{label}' → '{value}'")

        # Strategy 1: Lightning contenteditable div
        richtext_selectors = [
            f"lightning-input-rich-text:has-text('{label}') div[contenteditable='true']",
            f"lightning-input-field:has-text('{label}') div[contenteditable='true']",
            f".slds-form-element:has-text('{label}') div[contenteditable='true']",
            f"lightning-input-rich-text:has-text('{label}') .ql-editor",
            f".slds-rich-text-area__content[contenteditable='true']",
        ]
        for sel in richtext_selectors:
            try:
                loc = page.locator(sel)
                if await loc.count() == 0:
                    continue
                el = loc.first
                await el.scroll_into_view_if_needed(timeout=5000)
                await el.click(timeout=5000)
                await asyncio.sleep(0.3)

                # Clear existing content
                await page.keyboard.press("Control+a")
                await asyncio.sleep(0.1)

                # Type the value
                await page.keyboard.type(value or "", delay=30)
                await asyncio.sleep(0.3)
                await page.keyboard.press("Tab")
                await asyncio.sleep(0.3)
                logger.info(f"  → Rich text '{label}' filled via {sel}")
                return True
            except Exception as e:
                logger.debug(f"  Rich text strategy {sel} failed: {e}")
                continue

        # Strategy 2: iframe-based editor (some orgs use CKEditor)
        try:
            editor_container = page.locator(
                f"lightning-input-rich-text:has-text('{label}'), "
                f"lightning-input-field:has-text('{label}')"
            )
            if await editor_container.count() > 0:
                iframe = editor_container.first.locator("iframe")
                if await iframe.count() > 0:
                    frame = iframe.first.content_frame
                    if frame:
                        body = frame.locator("body")
                        await body.click(timeout=5000)
                        await asyncio.sleep(0.3)
                        await frame.locator("body").fill(value or "")
                        logger.info(f"  → Rich text '{label}' filled via iframe editor")
                        return True
        except Exception as e:
            logger.debug(f"  Rich text iframe fallback failed: {e}")

        # Strategy 3: JS fallback — set innerHTML on contenteditable
        try:
            filled = await page.evaluate("""(args) => {
                const [labelText, fillValue] = args;
                const root = document.querySelector(
                    '.slds-modal__content, records-record-edit-form'
                ) || document.body;
                const labels = root.querySelectorAll(
                    'label, span.slds-form-element__label, legend'
                );
                for (const lbl of labels) {
                    if (!lbl.textContent || !lbl.textContent.trim().includes(labelText)) continue;
                    const container = lbl.closest(
                        'lightning-input-rich-text, lightning-input-field, .slds-form-element'
                    );
                    if (!container) continue;
                    const editor = container.querySelector(
                        '[contenteditable="true"], .ql-editor'
                    );
                    if (editor) {
                        editor.innerHTML = '<p>' + fillValue + '</p>';
                        editor.dispatchEvent(new Event('input', { bubbles: true }));
                        editor.dispatchEvent(new Event('change', { bubbles: true }));
                        return true;
                    }
                }
                return false;
            }""", [label, value or ""])
            if filled:
                logger.info(f"  → Rich text '{label}' filled via JS innerHTML")
                return True
        except Exception as e:
            logger.debug(f"  Rich text JS fallback failed: {e}")

        return False

    # ─────────────────────────────────────────────
    # A6: Time Field Handler
    # ─────────────────────────────────────────────

    @staticmethod
    async def _fill_time(page, label, value):
        """Fill a Lightning time field.

        Salesforce time fields use lightning-timepicker which renders
        an input with a combobox-style dropdown of time slots.

        Strategy: Click → clear → type time → Tab to commit.
        Value format: "HH:MM AM/PM" or "HH:MM" (24hr)
        """
        logger.info(f"  🕐 Time field: '{label}' → '{value}'")

        selectors = [
            f"lightning-timepicker:has-text('{label}') input",
            f"lightning-input-field:has-text('{label}') lightning-timepicker input",
            f"lightning-input:has-text('{label}') input[type='text']",
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

                # Select all and type
                await el.click(click_count=3, timeout=3000)
                await asyncio.sleep(0.2)
                await page.keyboard.type(value or "", delay=50)
                await asyncio.sleep(0.3)
                await page.keyboard.press("Tab")
                await asyncio.sleep(0.5)

                # Dismiss any dropdown
                try:
                    await page.keyboard.press("Escape")
                    await asyncio.sleep(0.2)
                except Exception:
                    pass

                logger.info(f"  → Time field '{label}' filled via {sel}")
                return True
            except Exception as e:
                logger.debug(f"  Time strategy {sel} failed: {e}")
                continue

        return False

    # ─────────────────────────────────────────────
    # A4: File Upload Handler
    # ─────────────────────────────────────────────

    @staticmethod
    async def _fill_file_upload(page, label, file_path):
        """Handle Salesforce file upload fields.

        Salesforce file uploads use:
        - lightning-file-upload component
        - Standard <input type="file"> (hidden, triggered by button)

        Strategy: Find the file input, use set_input_files().
        """
        logger.info(f"  📁 File upload: '{label}' → '{file_path}'")

        file_selectors = [
            f"lightning-file-upload:has-text('{label}') input[type='file']",
            f"lightning-input-field:has-text('{label}') input[type='file']",
            f".slds-form-element:has-text('{label}') input[type='file']",
            f"input[type='file'][aria-label*='{label}']",
            f"input[type='file'][name*='{label}']",
        ]
        for sel in file_selectors:
            try:
                loc = page.locator(sel)
                if await loc.count() == 0:
                    continue
                # set_input_files works even on hidden file inputs
                await loc.first.set_input_files(file_path)
                await asyncio.sleep(2)  # Wait for upload
                logger.info(f"  → File uploaded for '{label}' via {sel}")
                return True
            except Exception as e:
                logger.debug(f"  File upload {sel} failed: {e}")
                continue

        # Strategy 2: JS — find hidden file input near the label
        try:
            input_found = await page.evaluate("""(labelText) => {
                const root = document.querySelector(
                    '.slds-modal__content, records-record-edit-form'
                ) || document.body;
                const labels = root.querySelectorAll(
                    'label, span.slds-form-element__label, legend, .slds-file-selector__button'
                );
                for (const lbl of labels) {
                    if (!lbl.textContent || !lbl.textContent.trim().includes(labelText)) continue;
                    const container = lbl.closest(
                        'lightning-file-upload, lightning-input-field, .slds-form-element'
                    );
                    if (!container) continue;
                    const input = container.querySelector('input[type="file"]');
                    if (input) {
                        input.style.display = 'block';
                        input.style.opacity = '1';
                        return true;
                    }
                }
                return false;
            }""", label)
            if input_found:
                # Now the file input should be visible
                visible_input = page.locator(f"input[type='file']:visible")
                if await visible_input.count() > 0:
                    await visible_input.first.set_input_files(file_path)
                    await asyncio.sleep(2)
                    logger.info(f"  → File uploaded for '{label}' via JS reveal + set_input_files")
                    return True
        except Exception as e:
            logger.debug(f"  File upload JS fallback failed: {e}")

        return False

    # ─────────────────────────────────────────────
    # B10: Record Type Selector Handler
    # ─────────────────────────────────────────────

    @staticmethod
    async def handle_record_type_modal(page, record_type_name=None):
        """Handle the Record Type selection modal that appears before the new record form.

        When a Salesforce object has multiple record types, clicking "New" opens
        a modal asking the user to select a Record Type before showing the form.

        Args:
            page: Playwright page
            record_type_name: Optional specific record type to select.
                            If None, selects the first/default option.

        Returns:
            True if a record type modal was handled, False if not detected.
        """
        logger.info("  🏷 Checking for Record Type selection modal...")

        # Detect the Record Type modal
        rt_modal_indicators = [
            "h2:has-text('Select a record type')",
            "h2:has-text('New ')",
            ".slds-modal h2:has-text('record type')",
            "div.changeRecordTypeOptionRightColumn",
            ".slds-radio_button-group",
            "records-recordtype-picking",
        ]

        modal_found = False
        for indicator in rt_modal_indicators:
            try:
                loc = page.locator(indicator)
                if await loc.count() > 0 and await loc.first.is_visible():
                    modal_found = True
                    logger.info(f"  → Record Type modal detected via: {indicator}")
                    break
            except Exception:
                continue

        if not modal_found:
            return False

        await asyncio.sleep(0.5)

        # If a specific record type was requested, select it
        if record_type_name:
            rt_option_selectors = [
                f"label:has-text('{record_type_name}')",
                f"span.slds-radio__label:has-text('{record_type_name}')",
                f"[role='radio']:has-text('{record_type_name}')",
                f"input[type='radio'][value='{record_type_name}']",
            ]
            for rt_sel in rt_option_selectors:
                try:
                    opt = page.locator(rt_sel)
                    if await opt.count() > 0:
                        await opt.first.click(timeout=5000)
                        logger.info(f"  → Selected Record Type: '{record_type_name}'")
                        await asyncio.sleep(0.3)
                        break
                except Exception:
                    continue

        # Click "Next" or "Continue" button to proceed
        next_buttons = [
            "button:has-text('Next')",
            "button:has-text('Continue')",
            ".slds-modal button.slds-button--brand",
            ".slds-modal button.slds-button_brand",
        ]
        for nb_sel in next_buttons:
            try:
                btn = page.locator(nb_sel)
                if await btn.count() > 0 and await btn.first.is_visible():
                    await btn.first.click(timeout=5000)
                    logger.info(f"  → Clicked 'Next' on Record Type modal")
                    await asyncio.sleep(1)
                    return True
            except Exception:
                continue

        logger.warning("  ⚠ Record Type modal detected but could not proceed")
        return False

    # ─────────────────────────────────────────────
    # E2: Spinner Wait Utility
    # ─────────────────────────────────────────────

    @staticmethod
    async def wait_for_spinner_gone(page, timeout=15000):
        """Wait for all Salesforce Lightning spinners to disappear.

        Common after Save, navigation, or modal actions.
        """
        spinner_selectors = (
            "lightning-spinner, .slds-spinner, "
            ".slds-spinner_container:not(.slds-hide), "
            "div.slds-spinner_container:not([class*='slds-hide'])"
        )
        try:
            spinner = page.locator(spinner_selectors)
            # Only wait if a spinner is currently visible
            if await spinner.count() > 0:
                logger.info("  ℹ Spinner detected, waiting for it to clear...")
                await spinner.first.wait_for(state="hidden", timeout=timeout)
                logger.info("  ℹ Spinner cleared")
                await asyncio.sleep(0.3)
        except Exception:
            # Spinner may have disappeared during our check
            pass

    # ─────────────────────────────────────────────
    # B1: Inline Edit Handler
    # ─────────────────────────────────────────────

    @staticmethod
    async def inline_edit(page, label, value, field_type="text", metadata_map=None):
        """Perform an inline edit on a Salesforce record detail page.

        Salesforce inline editing:
        - Hover over the field value to reveal the pencil icon
        - Click the pencil icon (or double-click the field value)
        - The field becomes editable inline
        - Fill the value
        - Click the checkmark (save inline) or the page Save button

        Args:
            page: Playwright page
            label: Field label text
            value: New value to set
            field_type: 'text', 'picklist', 'lookup', 'date', 'checkbox'
            metadata_map: Optional MCP metadata for field type detection
        """
        logger.info(f"  ✏ Inline Edit: '{label}' → '{value}'")

        # ─── Step 1: Auto-detect field type from metadata if not specified ───
        if metadata_map and field_type == "text":
            meta = metadata_map.get(label)
            if not meta:
                for ml, mi in metadata_map.items():
                    if label.lower() in ml.lower() or ml.lower() in label.lower():
                        meta = mi
                        break
            if meta:
                sf_type = meta.get("type", "")
                if sf_type in ("picklist", "combobox"):
                    field_type = "picklist"
                elif sf_type == "reference":
                    field_type = "lookup"
                elif sf_type in ("date", "datetime"):
                    field_type = "date"
                elif sf_type == "boolean":
                    field_type = "checkbox"
                elif sf_type == "multipicklist":
                    field_type = "multipicklist"

        # ─── Step 2: Find the field on the detail page ───
        field_containers = [
            f"records-record-layout-item:has-text('{label}')",
            f"force-record-layout-item:has-text('{label}')",
            f"records-output-field:has-text('{label}')",
            f".slds-form-element:has-text('{label}')",
            f"[data-field-label='{label}']",
        ]

        field_container = None
        for fc_sel in field_containers:
            try:
                loc = page.locator(fc_sel)
                if await loc.count() > 0 and await loc.first.is_visible():
                    field_container = loc.first
                    logger.info(f"  → Found field container for '{label}' via: {fc_sel}")
                    break
            except Exception:
                continue

        if not field_container:
            logger.warning(f"  ⚠ Inline edit: field container not found for '{label}'")
            return False

        # ─── Step 3: Hover to show pencil icon, then click it ───
        try:
            await field_container.scroll_into_view_if_needed(timeout=5000)
            await field_container.hover(timeout=5000)
            await asyncio.sleep(0.5)

            # Try clicking the pencil/edit button
            pencil_selectors = [
                "button.slds-button_icon[title*='Edit']",
                "button[data-target-selection-name*='edit']",
                "a.inlineEditTrigger",
                ".slds-cell-edit button",
                "button.slds-button_icon-edit",
                "[title='Edit']",
            ]
            pencil_found = False
            for ps in pencil_selectors:
                try:
                    pencil = field_container.locator(ps)
                    if await pencil.count() > 0 and await pencil.first.is_visible():
                        await pencil.first.click(timeout=5000)
                        pencil_found = True
                        logger.info(f"  → Clicked pencil icon via: {ps}")
                        await asyncio.sleep(0.5)
                        break
                except Exception:
                    continue

            if not pencil_found:
                # Try double-clicking the field value (triggers inline edit in some orgs)
                try:
                    value_el = field_container.locator(
                        "span.slds-form-element__static, .slds-form-element__static"
                    )
                    if await value_el.count() > 0:
                        await value_el.first.dblclick(timeout=5000)
                        logger.info(f"  → Double-clicked field value to trigger inline edit")
                        await asyncio.sleep(0.5)
                    else:
                        logger.warning(f"  ⚠ Could not find pencil or value element for '{label}'")
                        return False
                except Exception as e:
                    logger.warning(f"  ⚠ Double-click failed: {e}")
                    return False
        except Exception as e:
            logger.warning(f"  ⚠ Inline edit hover/pencil failed for '{label}': {e}")
            return False

        # ─── Step 4: Fill the now-editable field ───
        await asyncio.sleep(0.5)
        filled = False

        if field_type == "picklist":
            filled = await SalesforceLightningEngine._fill_picklist(page, label, value)
        elif field_type == "multipicklist":
            filled = await SalesforceLightningEngine._fill_multi_picklist(page, label, value)
        elif field_type == "lookup":
            filled = await SalesforceLightningEngine._fill_lookup(page, label, value)
        elif field_type == "date":
            filled = await SalesforceLightningEngine._fill_date(page, label, value)
        elif field_type == "checkbox":
            filled = await SalesforceLightningEngine._fill_checkbox(page, label, value)
        else:
            # Text field inline edit
            text_selectors = [
                f"records-record-layout-item:has-text('{label}') input",
                f"records-record-layout-item:has-text('{label}') textarea",
                f"force-record-layout-item:has-text('{label}') input",
                f".slds-form-element:has-text('{label}') input",
            ]
            for ts in text_selectors:
                try:
                    inp = page.locator(ts)
                    if await inp.count() > 0 and await inp.first.is_visible():
                        await inp.first.click(timeout=3000)
                        await asyncio.sleep(0.2)
                        await inp.first.press("Control+a")
                        await page.keyboard.type(value or "", delay=50)
                        filled = True
                        logger.info(f"  → Typed '{value}' into inline text field")
                        break
                except Exception:
                    continue

        if not filled:
            logger.warning(f"  ⚠ Could not fill inline edit for '{label}'")
            return False

        # ─── Step 5: Confirm/save the inline edit ───
        await asyncio.sleep(0.3)
        confirm_selectors = [
            "button[title='Save'][class*='slds']",
            "button.slds-button_save",
            ".inlineEditSaveCol button",
            "button[title='Save edit']",
            "button[aria-label='Save']",
        ]
        for cs in confirm_selectors:
            try:
                confirm_btn = page.locator(cs)
                if await confirm_btn.count() > 0 and await confirm_btn.first.is_visible():
                    await confirm_btn.first.click(timeout=5000)
                    await asyncio.sleep(1)
                    logger.info(f"  ✅ Inline edit saved for '{label}'")
                    return True
            except Exception:
                continue

        # If no inline save button, press Tab/Enter to commit
        try:
            await page.keyboard.press("Tab")
            await asyncio.sleep(0.3)
            logger.info(f"  → Committed inline edit via Tab")
            return True
        except Exception:
            pass

        return False

    # ─────────────────────────────────────────────
    # B4: Quick Action Menu Handler
    # ─────────────────────────────────────────────

    @staticmethod
    async def click_quick_action(page, action_name):
        """Click a Quick Action from the Salesforce record action menu.

        Quick Actions appear in:
        - The highlights panel action bar (direct buttons like Log a Call, New Task)
        - The overflow dropdown (▾ button) for additional actions
        - Global actions button bar

        Strategy:
        1. Check if the action is directly visible as a button
        2. If not, open the overflow/more-actions dropdown
        3. Click the action from the dropdown
        """
        logger.info(f"  ⚡ Quick Action: '{action_name}'")

        # Strategy 1: Direct button in the action bar
        direct_selectors = [
            f"button:has-text('{action_name}')",
            f"a[title='{action_name}']",
            f"force-quick-action-bubble:has-text('{action_name}')",
            f"lightning-action-bar button:has-text('{action_name}')",
            f"[title='{action_name}']",
        ]
        for ds in direct_selectors:
            try:
                loc = page.locator(ds)
                if await loc.count() > 0 and await loc.first.is_visible():
                    await loc.first.click(timeout=5000)
                    await asyncio.sleep(1)
                    logger.info(f"  → Clicked quick action directly: '{action_name}'")
                    return True
            except Exception:
                continue

        # Strategy 2: Open overflow/more-actions dropdown
        overflow_selectors = [
            "button[title='More Actions']",
            "button[aria-label='More Actions']",
            ".slds-button_icon-more",
            "button[title='More actions']",
            "a.more-desktop",
            "li.oneActionsRibbon__overflowButton button",
        ]
        for os_sel in overflow_selectors:
            try:
                overflow = page.locator(os_sel)
                if await overflow.count() > 0 and await overflow.first.is_visible():
                    await overflow.first.click(timeout=5000)
                    await asyncio.sleep(0.7)
                    logger.info(f"  → Opened overflow menu via: {os_sel}")

                    # Now find the action in the dropdown
                    action_in_dropdown = [
                        f"[role='menuitem']:has-text('{action_name}')",
                        f"a:has-text('{action_name}')",
                        f"lightning-menu-item:has-text('{action_name}')",
                    ]
                    for adi in action_in_dropdown:
                        try:
                            item = page.locator(adi)
                            if await item.count() > 0 and await item.first.is_visible():
                                await item.first.click(timeout=5000)
                                await asyncio.sleep(1)
                                logger.info(f"  ✅ Clicked '{action_name}' from overflow dropdown")
                                return True
                        except Exception:
                            continue

                    # Esc to close if not found
                    await page.keyboard.press("Escape")
                    await asyncio.sleep(0.3)
                    break
            except Exception:
                continue

        logger.warning(f"  ⚠ Quick action '{action_name}' not found")
        return False

    # ─────────────────────────────────────────────
    # B5: List View Row Action Handler
    # ─────────────────────────────────────────────

    @staticmethod
    async def click_list_view_row_action(page, record_name, action_name):
        """Click a row-level action in a Salesforce list view.

        Each row in a list view has a dropdown arrow (▾) with actions like:
        Edit, Delete, Change Owner, Clone, etc.

        Args:
            page: Playwright page
            record_name: The visible name/text of the record (to identify the row)
            action_name: The action to click (e.g., 'Edit', 'Delete', 'Clone')
        """
        logger.info(f"  📋 List View Row Action: '{action_name}' on '{record_name}'")

        # ─── Step 1: Find the row containing the record ───
        row_selectors = [
            f"tr:has-text('{record_name}')",
            f"[role='row']:has-text('{record_name}')",
            f"tbody tr:has(a:has-text('{record_name}'))",
        ]
        row = None
        for rs in row_selectors:
            try:
                loc = page.locator(rs)
                if await loc.count() > 0:
                    # Pick the most specific visible row
                    for i in range(min(await loc.count(), 5)):
                        candidate = loc.nth(i)
                        if await candidate.is_visible():
                            row = candidate
                            logger.info(f"  → Found row for '{record_name}' via: {rs}")
                            break
                    if row:
                        break
            except Exception:
                continue

        if not row:
            logger.warning(f"  ⚠ Row not found for '{record_name}'")
            return False

        # ─── Step 2: Click the row dropdown button ───
        dropdown_selectors = [
            "button[aria-haspopup='menu']",
            "lightning-button-menu button",
            "button[title*='Show Actions']",
            "button[aria-label*='Show Actions']",
            ".slds-button_icon-border-filled",
        ]
        dropdown_found = False
        for dds in dropdown_selectors:
            try:
                dropdown_btn = row.locator(dds)
                if await dropdown_btn.count() > 0:
                    await dropdown_btn.first.scroll_into_view_if_needed(timeout=3000)
                    await dropdown_btn.first.click(timeout=5000)
                    await asyncio.sleep(0.7)
                    dropdown_found = True
                    logger.info(f"  → Opened row dropdown via: {dds}")
                    break
            except Exception:
                continue

        if not dropdown_found:
            logger.warning(f"  ⚠ Row dropdown button not found for '{record_name}'")
            return False

        # ─── Step 3: Click the action ───
        action_selectors = [
            f"[role='menuitem']:has-text('{action_name}')",
            f"lightning-menu-item:has-text('{action_name}')",
            f"a:has-text('{action_name}')",
            f"span:has-text('{action_name}')",
        ]
        for acs in action_selectors:
            try:
                action_item = page.locator(acs)
                if await action_item.count() > 0 and await action_item.first.is_visible():
                    await action_item.first.click(timeout=5000)
                    await asyncio.sleep(1)
                    logger.info(f"  ✅ Clicked '{action_name}' from row dropdown")
                    return True
            except Exception:
                continue

        # Close dropdown if action not found
        try:
            await page.keyboard.press("Escape")
        except Exception:
            pass

        logger.warning(f"  ⚠ Action '{action_name}' not found in row dropdown")
        return False

    # ─────────────────────────────────────────────
    # B8: Toast Dismissal Handler
    # ─────────────────────────────────────────────

    @staticmethod
    async def dismiss_toast(page, timeout=5000):
        """Dismiss a Salesforce toast notification.

        Some workflows require the toast to be dismissed before the
        next interaction (it can block elements underneath it).

        Clicks the toast's close button if found.
        Returns True if a toast was dismissed, False if no toast.
        """
        toast_close_selectors = [
            ".toastClose",
            "button.slds-notify__close",
            ".slds-notify_toast button[title='Close']",
            ".slds-notify_container button[title='Close']",
            "button[title='Close'][class*='toast']",
            ".slds-notification-list button[title='Close']",
        ]
        for tcs in toast_close_selectors:
            try:
                close_btn = page.locator(tcs)
                if await close_btn.count() > 0 and await close_btn.first.is_visible():
                    await close_btn.first.click(timeout=timeout)
                    await asyncio.sleep(0.5)
                    logger.info("  → Toast dismissed")
                    return True
            except Exception:
                continue

        # Alternative: wait for toast to auto-dismiss
        try:
            toast = page.locator(
                ".toastMessage, .forceToastMessage, .slds-notify_toast"
            )
            if await toast.count() > 0:
                # Wait for it to disappear naturally (max 5s)
                await toast.first.wait_for(state="hidden", timeout=5000)
                logger.info("  → Toast auto-dismissed")
                return True
        except Exception:
            pass

        return False

    # ─────────────────────────────────────────────
    # B9: Path / Kanban Stage Handler
    # ─────────────────────────────────────────────

    @staticmethod
    async def click_path_stage(page, stage_name):
        """Update a record stage via the Salesforce Path component.

        The Path component renders as a horizontal progress indicator
        (lightning-path, force-path-element, opportunity-path, lead-path).
        Clicking a stage moves the record to that stage.

        Args:
            page: Playwright page
            stage_name: Name of the stage to click (e.g., 'Closed Won', 'Qualified')
        """
        logger.info(f"  🛤 Path stage: '{stage_name}'")

        # Strategy 1: Direct path item click
        path_selectors = [
            f"lightning-path-coaching a:has-text('{stage_name}')",
            f"a.slds-path__link:has-text('{stage_name}')",
            f"li.slds-path__item:has-text('{stage_name}')",
            f"[data-value='{stage_name}']",
            f"button:has-text('{stage_name}')",
            f"a[title='{stage_name}']",
        ]
        for ps in path_selectors:
            try:
                loc = page.locator(ps)
                if await loc.count() > 0 and await loc.first.is_visible():
                    await loc.first.scroll_into_view_if_needed(timeout=3000)
                    await loc.first.click(timeout=5000)
                    await asyncio.sleep(1)
                    logger.info(f"  → Clicked path stage: '{stage_name}'")

                    # Look for "Mark Stage as Complete" or "Select Closed Stage" button
                    confirm_btns = [
                        "button:has-text('Mark Stage as Complete')",
                        "button:has-text('Select Closed Stage')",
                        "button:has-text('Mark as Current Stage')",
                        "button:has-text('Mark Stage as Current')",
                        "button:has-text('Save')",
                    ]
                    for cb in confirm_btns:
                        try:
                            btn = page.locator(cb)
                            if await btn.count() > 0 and await btn.first.is_visible():
                                await btn.first.click(timeout=5000)
                                await asyncio.sleep(1)
                                logger.info(f"  → Confirmed stage via: {cb}")
                                break
                        except Exception:
                            continue

                    # Wait for spinner
                    await SalesforceLightningEngine.wait_for_spinner_gone(page)
                    return True
            except Exception:
                continue

        # Strategy 2: Try Kanban card drag-by-picklist update
        try:
            # Some records use a picklist for stage rather than the path
            success = await SalesforceLightningEngine._fill_picklist(page, "Stage", stage_name)
            if success:
                logger.info(f"  → Stage '{stage_name}' set via picklist fallback")
                return True
        except Exception:
            pass

        logger.warning(f"  ⚠ Path stage '{stage_name}' not found")
        return False

    # ─────────────────────────────────────────────
    # E3: Duplicate Rule Popup Handler
    # ─────────────────────────────────────────────

    @staticmethod
    async def handle_duplicate_popup(page, action="save_anyway"):
        """Handle the Salesforce Duplicate Rule popup.

        When saving a record, SF Duplicate Rules may show a modal:
        'Potential Duplicates Found' with options:
        - Save Anyway / Continue Saving (proceed)
        - Cancel (abort)
        - View Duplicates (navigate to dupe record)

        Args:
            page: Playwright page
            action: 'save_anyway' (default), 'cancel', or 'view_duplicates'
        Returns:
            True if duplicate popup was detected and handled,
            False if no duplicate popup appeared.
        """
        logger.info(f"  🔁 Checking for Duplicate Rule popup (action={action})...")

        # Detect duplicate popup
        dupe_indicators = [
            "h2:has-text('Potential Duplicate')",
            "h2:has-text('Duplicate')",
            ".slds-modal h2:has-text('duplicate')",
            "duplicaterecordsets-duplicate-record-set-list",
            "records-form-footer:has-text('Save Anyway')",
            "button:has-text('Save Anyway')",
        ]
        popup_found = False
        for di in dupe_indicators:
            try:
                loc = page.locator(di)
                if await loc.count() > 0 and await loc.first.is_visible():
                    popup_found = True
                    logger.info(f"  → Duplicate popup detected via: {di}")
                    break
            except Exception:
                continue

        if not popup_found:
            return False

        await asyncio.sleep(0.5)

        if action == "save_anyway":
            save_anyway_selectors = [
                "button:has-text('Save Anyway')",
                "button:has-text('Continue Saving')",
                "button:has-text('Ignore and Save')",
                ".slds-modal button.slds-button_brand",
            ]
            for sas in save_anyway_selectors:
                try:
                    btn = page.locator(sas)
                    if await btn.count() > 0 and await btn.first.is_visible():
                        await btn.first.click(timeout=5000)
                        await asyncio.sleep(1)
                        logger.info("  → Clicked 'Save Anyway' on duplicate popup")
                        await SalesforceLightningEngine.wait_for_spinner_gone(page)
                        return True
                except Exception:
                    continue

        elif action == "cancel":
            cancel_selectors = [
                "button:has-text('Cancel')",
                ".slds-modal button:has-text('Cancel')",
            ]
            for cs in cancel_selectors:
                try:
                    btn = page.locator(cs)
                    if await btn.count() > 0 and await btn.first.is_visible():
                        await btn.first.click(timeout=5000)
                        await asyncio.sleep(0.5)
                        logger.info("  → Cancelled duplicate popup")
                        return True
                except Exception:
                    continue

        elif action == "view_duplicates":
            view_selectors = [
                "button:has-text('View Duplicates')",
                "a:has-text('View Duplicates')",
            ]
            for vs in view_selectors:
                try:
                    btn = page.locator(vs)
                    if await btn.count() > 0 and await btn.first.is_visible():
                        await btn.first.click(timeout=5000)
                        await asyncio.sleep(2)
                        logger.info("  → Navigated to duplicate records")
                        return True
                except Exception:
                    continue

        logger.warning(f"  ⚠ Duplicate popup found but could not perform '{action}'")
        return False

    # ─────────────────────────────────────────────
    # E7: Dynamic Forms / Conditional Visibility Check
    # ─────────────────────────────────────────────

    @staticmethod
    async def check_field_visible_dynamic(page, label, timeout=5000):
        """Check if a field is currently visible on a page with Dynamic Forms.

        With Salesforce Dynamic Forms, fields are shown/hidden based on conditions.
        Call this before attempting to fill a field — if it returns False,
        skip the field fill gracefully rather than raising an error.

        Returns:
            True if the field is visible and fillable
            False if the field is hidden (skip gracefully)
        """
        visibility_selectors = [
            f"lightning-input-field:has-text('{label}')",
            f"lightning-input:has-text('{label}')",
            f"lightning-textarea:has-text('{label}')",
            f"lightning-combobox:has-text('{label}')",
            f".slds-form-element:has-text('{label}')",
        ]
        for sel in visibility_selectors:
            try:
                loc = page.locator(sel)
                if await loc.count() == 0:
                    continue
                el = loc.first
                is_vis = await el.is_visible()
                if is_vis:
                    logger.info(f"  → Field '{label}' is visible (Dynamic Forms)")
                    return True
                else:
                    logger.info(f"  → Field '{label}' is HIDDEN (Dynamic Forms — condition not met)")
                    return False
            except Exception:
                continue
        # Field not found at all
        logger.info(f"  → Field '{label}' not found on page (Dynamic Forms)")
        return False

    @staticmethod
    async def fill_field_if_visible(page, label, value, field_map=None, metadata_map=None):
        """Fill a field only if it's visible (Dynamic Forms safe variant).

        Use this instead of fill_field() on pages with Dynamic Forms
        so that hidden fields are silently skipped rather than failing.

        Returns:
            'filled' — field was visible and filled
            'hidden' — field was not visible, skipped
            'failed' — field was visible but fill failed
        """
        is_visible = await SalesforceLightningEngine.check_field_visible_dynamic(page, label)
        if not is_visible:
            logger.info(f"  ℹ Skipping hidden field '{label}' (Dynamic Forms)")
            return "hidden"
        try:
            await SalesforceLightningEngine.fill_field(page, label, value, field_map, metadata_map)
            return "filled"
        except Exception as e:
            logger.warning(f"  ⚠ fill_field_if_visible: fill failed for '{label}': {e}")
            return "failed"

    # ─────────────────────────────────────────────
    # A5: Compound Address Field Handler
    # ─────────────────────────────────────────────

    @staticmethod
    async def _fill_address(page, label, value):
        """Fill a Salesforce compound address field (lightning-input-address).

        Compound address fields render sub-fields:
        - Street (textarea)
        - City (input)
        - State/Province (picklist or input)
        - Zip/Postal Code (input)
        - Country (picklist or input)

        Value format options:
        - Plain string → fills Street only
        - Dict: {'street': ..., 'city': ..., 'state': ..., 'zip': ..., 'country': ...}
        - Comma-separated: "123 Main St, Springfield, IL, 62701, USA"

        Args:
            page: Playwright page
            label: Field label (e.g., "Billing Address", "Mailing Address")
            value: Address string or dict
        """
        logger.info(f"  🏠 Address field: '{label}' → '{value}'")

        # Parse value into components
        address = {}
        if isinstance(value, dict):
            address = value
        elif isinstance(value, str) and "," in value:
            parts = [p.strip() for p in value.split(",")]
            if len(parts) >= 1:
                address["street"] = parts[0]
            if len(parts) >= 2:
                address["city"] = parts[1]
            if len(parts) >= 3:
                address["state"] = parts[2]
            if len(parts) >= 4:
                address["zip"] = parts[3]
            if len(parts) >= 5:
                address["country"] = parts[4]
        else:
            address["street"] = value  # Treat as street only

        # ─── Find the address component container ───
        addr_container_selectors = [
            f"lightning-input-address:has-text('{label}')",
            f"lightning-input-field:has-text('{label}') lightning-input-address",
            f".slds-form-element:has-text('{label}') lightning-input-address",
            f"[data-field-label='{label}']",
        ]
        container = None
        for asel in addr_container_selectors:
            try:
                loc = page.locator(asel)
                if await loc.count() > 0:
                    container = loc.first
                    logger.info(f"  → Found address container via: {asel}")
                    break
            except Exception:
                continue

        if not container:
            # Try to fill as generic text (some addresses are simple textarea)
            logger.info(f"  → No compound address component found, trying generic fill")
            return await SalesforceLightningEngine._fill_generic(page, label, address.get("street", value))

        filled_any = False

        # ─── Fill Street ───
        if address.get("street"):
            for sel in ["textarea[name='street']", "textarea[placeholder*='treet']", "textarea"]:
                try:
                    inp = container.locator(sel)
                    if await inp.count() > 0 and await inp.first.is_visible():
                        await inp.first.click(timeout=3000)
                        await inp.first.fill(address["street"])
                        filled_any = True
                        logger.info(f"  → Street filled: '{address['street']}'")
                        break
                except Exception:
                    continue

        # ─── Fill City ───
        if address.get("city"):
            for sel in ["input[name='city']", "input[placeholder*='ity']"]:
                try:
                    inp = container.locator(sel)
                    if await inp.count() > 0 and await inp.first.is_visible():
                        await inp.first.click(timeout=3000)
                        await inp.first.fill(address["city"])
                        filled_any = True
                        logger.info(f"  → City filled: '{address['city']}'")
                        break
                except Exception:
                    continue

        # ─── Fill State (try picklist first, then text) ───
        if address.get("state"):
            state_filled = False
            for sel in ["select[name='province']", "lightning-combobox[name='province']"]:
                try:
                    inp = container.locator(sel)
                    if await inp.count() > 0:
                        await inp.first.select_option(label=address["state"])
                        state_filled = True
                        filled_any = True
                        logger.info(f"  → State filled (select): '{address['state']}'")
                        break
                except Exception:
                    continue
            if not state_filled:
                for sel in ["input[name='province']", "input[placeholder*='tate']"]:
                    try:
                        inp = container.locator(sel)
                        if await inp.count() > 0 and await inp.first.is_visible():
                            await inp.first.fill(address["state"])
                            filled_any = True
                            logger.info(f"  → State filled (text): '{address['state']}'")
                            break
                    except Exception:
                        continue

        # ─── Fill Zip ───
        if address.get("zip"):
            for sel in ["input[name='postalCode']", "input[placeholder*='ip']", "input[name='postal_code']"]:
                try:
                    inp = container.locator(sel)
                    if await inp.count() > 0 and await inp.first.is_visible():
                        await inp.first.fill(address["zip"])
                        filled_any = True
                        logger.info(f"  → Zip filled: '{address['zip']}'")
                        break
                except Exception:
                    continue

        # ─── Fill Country ───
        if address.get("country"):
            country_filled = False
            for sel in ["select[name='country']", "lightning-combobox[name='country']"]:
                try:
                    inp = container.locator(sel)
                    if await inp.count() > 0:
                        await inp.first.select_option(label=address["country"])
                        country_filled = True
                        filled_any = True
                        logger.info(f"  → Country filled (select): '{address['country']}'")
                        break
                except Exception:
                    continue
            if not country_filled:
                for sel in ["input[name='country']", "input[placeholder*='ountry']"]:
                    try:
                        inp = container.locator(sel)
                        if await inp.count() > 0 and await inp.first.is_visible():
                            await inp.first.fill(address["country"])
                            filled_any = True
                            logger.info(f"  → Country filled (text): '{address['country']}'")
                            break
                    except Exception:
                        continue

        if filled_any:
            await page.keyboard.press("Tab")
            await asyncio.sleep(0.3)
            logger.info(f"  ✅ Address field '{label}' filled")

        return filled_any
