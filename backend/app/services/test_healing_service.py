"""
TestHealingService — AI Fix Assistant backend service.

Responsibilities:
1. Detect application-level errors in failed test run logs
2. Extract the Salesforce object name from failing step context
3. Fetch fresh field metadata from MCP
4. Call Claude to generate concrete fix suggestions (insert/modify steps)
5. Handle conversational follow-up chat via /heal endpoint
"""
import json
import logging
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ── Error patterns that indicate an application-level Salesforce failure ──────
APP_ERROR_PATTERNS = [
    "update failed",
    "required field",
    "first error:",
    "error in expression",
    "field integrity exception",
    "validation rule",
    "system.dmlexception",
    "insufficient access",
    "apex error",
    "the record couldn't be saved",
    "review the following",
    "save failed",
    "missing required",
    "subtree intercepts pointer events",
    "dependent picklist",
    "all strategies exhausted",
]

# ── Claude model for healing (Sonnet is fast + accurate enough) ───────────────
HEALING_MODEL = "claude-sonnet-4-20250514"

# ── System prompt for the AI Fix Assistant ────────────────────────────────────
HEALING_SYSTEM_PROMPT = """You are an expert Salesforce Lightning + Playwright test architect.

A test failed because of application errors (missing required fields, modal overlays, etc.).
Your job is to produce a COMPLETE, CORRECTED test steps array that will run successfully end-to-end.

═══ LOCATOR FORMAT REFERENCE (use these EXACTLY) ═══

For CLICK on a button:
  {"action":"click","target":"role=button, name=New","value":"","locator_type":"role"}
  {"action":"click","target":"button[name='Edit']","value":"","locator_type":"css"}
  {"action":"click","target":"role=button, name=Save","value":"","locator_type":"role"}

For CLICK on a link (record row):
  {"action":"click","target":"role=link, name=RecordName","value":"","locator_type":"role"}

For NAVIGATE:
  {"action":"navigate","target":"","value":"/lightning/o/{ObjectApiName}/list","locator_type":"url"}

For FILL a field by label:
  {"action":"fill","target":"FieldLabel","value":"...","locator_type":"label"}

For LOOKUP fields:
  {"action":"lookup","target":"AccountName","value":"Test Account - 1","locator_type":"label"}

For WAIT (milliseconds):
  {"action":"wait","target":"2000","value":"","locator_type":""}

For ASSERT TEXT on element:
  {"action":"assert_text","target":"was created","value":"","locator_type":"text"}

═══ CRITICAL RULES ═══

1. PRESERVE THE ORIGINAL TEST WORKFLOW (MOST IMPORTANT RULE):
   - Study the CURRENT TEST STEPS provided. They define the workflow pattern.
   - If the original test SEARCHES for and OPENS an existing record, keep that pattern:
     navigate → search → click record link → wait → click Edit → fill fields → Save
   - If the original test CREATES a new record, keep that pattern:
     navigate → click New → fill fields → Save
   - DO NOT change the workflow type. If the test opens an existing record,
     do NOT generate a "click New" create flow. If the test creates,
     do NOT generate an "open existing" edit flow.
   - Keep ALL passing steps (navigate, search, click record, wait, click Edit)
     exactly as they were in the original.
   - ONLY add/modify/reorder the FORM FIELD steps (fill, lookup, select) to fix the failure.
   - You CANNOT fill form fields on a list view page — you MUST first open or create a record.

2. ONLY generate steps relevant to the SPECIFIC OBJECT being tested.
   If the test is for Contact, generate ONLY Contact-related steps.
   If the test is for Invoice, generate ONLY Invoice-related steps.
   DO NOT mix steps from different objects.

2. After clicking a record link, INSERT A WAIT of 2000ms before the Edit button click.

3. REQUIRED FIELDS must be filled on the RECORD EDIT FORM.

4. For LOOKUP fields: use action="lookup" with locator_type="label".
   If the metadata says "USE ONE OF THESE REAL ORG VALUES", use one of those exact values.

5. For PICKLIST fields: use action="fill" with the exact picklist value from metadata.

6. For DATE fields: use MM/DD/YYYY format.

7. If the error mentions "subtree intercepts pointer events" or a modal blocking,
   the fix is usually to dismiss the modal first, not to change the field fill steps.

8. DEPENDENT FIELD ORDERING (CRITICAL — applies to BOTH picklists AND lookups):
   a. DEPENDENT PICKLISTS: If a picklist field depends on another ("controlled by"),
      the controlling field MUST be filled BEFORE the dependent field.
      Example: Entity → Tax Type. Fill Entity BEFORE Tax Type.
   b. FILTERED LOOKUPS: If a lookup field has a MANDATORY LOOKUP FILTER that
      references another field, that controlling field MUST be filled BEFORE
      the filtered lookup. Example: Entity → Pay To (Pay To's lookup filter
      depends on Entity). Fill Entity BEFORE Pay To.
   c. GENERAL RULE: Always generate PICKLIST and LOOKUP steps BEFORE text TYPE steps.
      Order: navigate → click New/Edit → wait → SELECT/LOOKUP fields → TYPE fields → Save
   d. If the metadata shows "DEPENDS ON: FieldX" or "FILTERED by: FieldX",
      FieldX's step MUST appear BEFORE the dependent field's step.

9. STEP ORDERING RULE (CRITICAL):
   Generate steps in this order within the form:
   1. Navigate → Click New/Edit → Wait
   2. PICKLIST/SELECT fields (controlling fields first)
   3. LOOKUP fields (non-filtered first, then filtered)
   4. TYPE/FILL fields (text, date, number, email, etc.)
   5. Click Save / Submit
   This prevents failures where a lookup dropdown has no options because
   its controlling field hasn't been filled yet.

═══ OUTPUT FORMAT ═══

Output ONLY a single JSON object, no markdown, no code fences:
{
  "analysis": "<one sentence: what was wrong and what you changed>",
  "corrected_steps": [
    {"step_order":1,"action":"navigate","target":"","value":"/lightning/o/{ObjectApiName}/list","locator_type":"url"},
    ...all corrected steps...
  ]
}

Include EVERY step from start to finish. The corrected_steps array must be complete and runnable.

═══ INTERACTIVE EDIT MODE ═══

If the user gives an edit instruction like:
- "Update step 14 as Order = 00000471"
- "Change step 8 value to Test Corp"
- "Make step 5 use lookup action instead"
- "Swap step 10 and 11"
- "Add a wait of 3000 after step 3"
- "Remove step 12"
- "Change step 6 action to select"

Rules:
1. ALWAYS start from the PREVIOUS corrected_steps provided.
2. Apply ONLY the requested change(s) — do not regenerate the whole test unless explicitly asked.
3. For value updates: match by step_order (1-based), update the "value" field.
4. For target updates: match by step_order, update the "target" field.
5. For action/locator_type changes: update those fields.
6. For reordering: adjust step_order numbers accordingly and keep logical sequence.
7. For adding steps: insert at the specified position and renumber subsequent steps.
8. For removing steps: remove and renumber.
9. If the change is invalid (e.g. step 99 doesn't exist), explain why in "analysis" and keep original steps.
10. Output the FULL updated corrected_steps array every time — never partial.
11. In "analysis", briefly describe what was changed (e.g. "Updated step 14 value to '00000471'").

Example user: "Update step 14 as Order = 00000471"
→ Find step with step_order=14, set value="00000471", keep everything else identical.
"""


class TestHealingService:
    """AI Fix Assistant — detects failures and generates Playwright fix suggestions."""

    # ── 1. Detect application errors in logs ─────────────────────────────────
    @staticmethod
    def detect_app_errors(logs: List[Dict]) -> Optional[Dict]:
        """
        Scan step logs for the first application-level failure.
        Returns a dict with: failing_step, error_message, step_order, action, target
        or None if no app-level error found.
        """
        if not logs:
            return None

        for log in logs:
            status = (log.get("status") or "").lower()
            error = (log.get("error") or "").lower()
            if status in ("failed", "error") and error:
                for pattern in APP_ERROR_PATTERNS:
                    if pattern in error:
                        return {
                            "failing_step": log,
                            "error_message": log.get("error", ""),
                            "step_order": log.get("step_order", 0),
                            "action": log.get("action", ""),
                            "target": log.get("target", ""),
                        }
        return None

    # ── 2. Infer Salesforce object name from logs/steps ───────────────────────
    @staticmethod
    def infer_object_name(logs: List[Dict], steps: List[Any]) -> Optional[str]:
        """
        Try to extract the Salesforce object API name from:
        - NAVIGATE step URLs (e.g. /lightning/o/Invoice__c/list → Invoice__c)
        - Step targets or values
        """
        # Check navigate URLs in steps
        nav_pattern = re.compile(r"/lightning/o/([A-Za-z0-9_]+)/", re.IGNORECASE)
        for step in steps:
            target = step.get("target", "") if isinstance(step, dict) else getattr(step, "target", "")
            value = step.get("value", "") if isinstance(step, dict) else getattr(step, "value", "")
            for text in [target, value]:
                match = nav_pattern.search(text)
                if match:
                    return match.group(1)

        # Check logs for navigate actions
        for log in logs:
            if (log.get("action") or "").lower() == "navigate":
                match = nav_pattern.search(log.get("target", ""))
                if match:
                    return match.group(1)

        return None

    # ── 3. Fetch MCP metadata for the object ─────────────────────────────────
    @staticmethod
    async def fetch_object_metadata(
        object_name: str,
        project_id: str,
        db_session,
    ) -> Optional[Dict]:
        """
        Pull field metadata for `object_name` via SalesforceMCPService.
        Returns a compact dict: {field_label: {required, type, picklist_values, api_name}}
        """
        try:
            from sqlalchemy.future import select
            from app.models.project_integration import ProjectIntegration
            from app.services.salesforce_mcp_service import SalesforceMCPService
            from app.services.integration_service import IntegrationService
            from uuid import UUID

            # Get project credentials
            result = await db_session.execute(
                select(ProjectIntegration).where(
                    ProjectIntegration.project_id == UUID(project_id)
                )
            )
            int_record = result.scalars().first()
            if not int_record or int_record.category != "salesforce":
                return None

            decrypted = await IntegrationService.get_decrypted_tokens(int_record)
            username = decrypted.get("username")
            password = decrypted.get("password")
            security_token = decrypted.get("security_token")
            if not (username and password and security_token):
                return None

            domain = "test" if (int_record.salesforce_login_url or "").find("test.salesforce.com") >= 0 else "login"
            metadata = SalesforceMCPService.describe_object(
                username=username,
                password=password,
                security_token=security_token,
                domain=domain,
                object_type=object_name,
            )
            return metadata

        except Exception as e:
            logger.warning(f"[HEALING] Could not fetch MCP metadata for {object_name}: {e}")
            return None

    # ── 3b. Query real record names for lookup fields ─────────────────────────
    @staticmethod
    async def fetch_lookup_values(
        metadata: Dict,
        project_id: str,
        db_session,
    ) -> Dict[str, List[str]]:
        """
        For each required reference (lookup) field in metadata, query the org
        for up to 5 real existing record Names so the LLM can use them.
        Returns: {field_label: ["Real Name 1", "Real Name 2"]}
        """
        lookup_options: Dict[str, List[str]] = {}
        if not metadata:
            return lookup_options

        fields = metadata.get("fields", [])
        if not isinstance(fields, list):
            return lookup_options

        try:
            from sqlalchemy.future import select
            from app.models.project_integration import ProjectIntegration
            from app.services.salesforce_mcp_service import SalesforceMCPService
            from app.services.integration_service import IntegrationService
            from uuid import UUID

            result = await db_session.execute(
                select(ProjectIntegration).where(
                    ProjectIntegration.project_id == UUID(project_id)
                )
            )
            int_record = result.scalars().first()
            if not int_record or int_record.category != "salesforce":
                return lookup_options

            decrypted = await IntegrationService.get_decrypted_tokens(int_record)
            username = decrypted.get("username")
            password = decrypted.get("password")
            security_token = decrypted.get("security_token")
            if not (username and password and security_token):
                return lookup_options

            domain = "test" if (int_record.salesforce_login_url or "").find("test.salesforce.com") >= 0 else "login"

            # Track which objects we've already queried (avoid duplicate queries)
            queried_objects: Dict[str, List[str]] = {}

            for field in fields:
                ftype = (field.get("type") or "").lower()
                ref_to = field.get("referenceTo") or []
                is_required = field.get("nillable") is False

                if ftype not in ("reference",) or not ref_to:
                    continue

                label = field.get("label", field.get("name", ""))
                api_name = field.get("name", "")
                # Use first referenced object type (most lookups have one)
                ref_object = ref_to[0] if ref_to else None
                if not ref_object:
                    continue

                # Check for mandatory lookup filter
                filtered_info = field.get("filteredLookupInfo") or {}
                has_mandatory_filter = (
                    isinstance(filtered_info, dict)
                    and filtered_info.get("optionalFilter") is False
                )

                # Build cache key: include filter status since same object
                # may need different queries for filtered vs unfiltered fields
                cache_key = f"{ref_object}__filtered" if has_mandatory_filter else ref_object

                if cache_key not in queried_objects:
                    try:
                        NAME_FIELD_MAP = {
                            "Order": "OrderNumber",
                            "Case": "CaseNumber",
                            "Solution": "SolutionName",
                            "Task": "Subject",
                            "Event": "Subject",
                            "ContentDocument": "Title",
                            "Document": "Name",
                        }
                        name_field = NAME_FIELD_MAP.get(ref_object, "Name")

                        # For filtered lookups, try to get filter criteria via Tooling API
                        filter_where = ""
                        if has_mandatory_filter and api_name:
                            try:
                                from simple_salesforce import Salesforce as _SF
                                sf_client = _SF(
                                    username=username, password=password,
                                    security_token=security_token, domain=domain,
                                )
                                # Query LookupFilter for this specific field
                                obj_api = api_name.split(".")[0] if "." in api_name else ""
                                tooling_soql = (
                                    f"SELECT Id, DeveloperName, SourceFieldDefinition.QualifiedApiName, "
                                    f"LookupObjectFieldDefinition.QualifiedApiName "
                                    f"FROM LookupFilter "
                                    f"WHERE SourceFieldDefinition.QualifiedApiName = '{api_name}' "
                                    f"OR SourceFieldDefinition.DurableId LIKE '%{api_name}%' "
                                    f"LIMIT 5"
                                )
                                tooling_result = sf_client.tooling.query(tooling_soql)
                                print(f"[HEALING] Tooling LookupFilter for {api_name}: {tooling_result.get('records', [])}")
                            except Exception as te:
                                print(f"[HEALING] Tooling API query failed for {api_name}: {te}")

                        # Use higher LIMIT for filtered fields to increase chances of finding valid records
                        limit = 20 if has_mandatory_filter else 5
                        soql = f"SELECT Id, {name_field} FROM {ref_object} WHERE {name_field} != null ORDER BY {name_field} LIMIT {limit}"
                        if filter_where:
                            soql = f"SELECT Id, {name_field} FROM {ref_object} WHERE {name_field} != null AND {filter_where} LIMIT {limit}"

                        result = SalesforceMCPService.query(
                            username=username,
                            password=password,
                            security_token=security_token,
                            domain=domain,
                            soql=soql,
                        )
                        records = result.get("records", []) if isinstance(result, dict) else (result or [])
                        names = [
                            r.get(name_field, "") for r in records
                            if r.get(name_field)
                        ]
                        queried_objects[cache_key] = names
                        filter_tag = " [HAS MANDATORY FILTER]" if has_mandatory_filter else ""
                        print(f"[HEALING] Lookup '{label}' → {ref_object}{filter_tag}: found {len(names)} records: {names}")
                        logger.info(f"[HEALING] Lookup '{label}' → {ref_object}{filter_tag}: found {len(names)} records: {names}")
                    except Exception as qe:
                        print(f"[HEALING] Could not query {ref_object} for lookup '{label}': {qe}")
                        logger.warning(f"[HEALING] Could not query {ref_object} for lookup '{label}': {qe}")
                        queried_objects[cache_key] = []

                names = queried_objects.get(cache_key, [])
                if names:
                    lookup_options[label] = names

        except Exception as e:
            logger.warning(f"[HEALING] fetch_lookup_values failed (non-critical): {e}")

        return lookup_options

    # ── 4. Build a compact metadata summary for the LLM ──────────────────────
    @staticmethod
    def _compact_metadata(raw_metadata: Dict, lookup_options: Optional[Dict] = None) -> str:
        """Convert full field metadata to a concise string for the LLM prompt."""
        if not raw_metadata:
            return "No metadata available."

        lines = []
        fields = raw_metadata.get("fields", raw_metadata) if isinstance(raw_metadata, dict) else {}
        if isinstance(fields, list):
            for f in fields:
                req = "REQUIRED" if f.get("nillable") is False and not f.get("defaultedOnCreate") else "optional"
                ftype = f.get("type", "text")
                label = f.get("label", "")
                api = f.get("name", label)

                if ftype == "picklist":
                    pv = f.get("picklistValues") or []
                    pv_values = []
                    if isinstance(pv, list) and pv:
                        for item in pv[:8]:
                            if isinstance(item, str):
                                pv_values.append(item)
                            elif isinstance(item, dict):
                                # Salesforce metadata returns {value, label, active}
                                val = item.get("value") or item.get("label") or ""
                                if val and item.get("active", True):
                                    pv_values.append(val)
                    pv_str = f" | ALLOWED VALUES: {', '.join(repr(v) for v in pv_values)}" if pv_values else ""
                    lines.append(f"  - {label} ({api}) [picklist, {req}]{pv_str}")

                elif ftype == "reference":
                    # Show REAL existing record names from the org if available
                    real_names = (lookup_options or {}).get(label, [])
                    ref_to = f.get("referenceTo") or []
                    ref_str = f" → refs: {', '.join(ref_to)}" if ref_to else ""
                    # Check for mandatory lookup filter
                    filtered_info = f.get("filteredLookupInfo") or {}
                    has_filter = (
                        isinstance(filtered_info, dict)
                        and filtered_info.get("optionalFilter") is False
                    )
                    filter_warning = ""
                    if has_filter:
                        filter_warning = " ⚠ THIS FIELD HAS A MANDATORY LOOKUP FILTER — not all records listed may be valid. Try each value in order until one is accepted."
                    if real_names:
                        lines.append(
                            f"  - {label} ({api}) [lookup, {req}]{ref_str}"
                            f" | USE ONE OF THESE REAL ORG VALUES: {', '.join(repr(n) for n in real_names)}"
                            f"{filter_warning}"
                        )
                    else:
                        lines.append(f"  - {label} ({api}) [lookup, {req}]{ref_str} | query org for real value{filter_warning}")

                else:
                    lines.append(f"  - {label} ({api}) [{ftype}, {req}]")

        elif isinstance(fields, dict):
            for label, info in fields.items():
                if isinstance(info, dict):
                    req = "REQUIRED" if info.get("required") else "optional"
                    ftype = info.get("type", "text")
                    api = info.get("api_name", label)
                    real_names = (lookup_options or {}).get(label, [])
                    if real_names:
                        lines.append(f"  - {label} ({api}) [{ftype}, {req}] | REAL ORG VALUES: {', '.join(repr(n) for n in real_names)}")
                    else:
                        pv = info.get("picklist_values", [])
                        pv_str = f" | values: {', '.join(pv[:5])}" if pv else ""
                        lines.append(f"  - {label} ({api}) [{ftype}, {req}]{pv_str}")

        # ── Add DEPENDENT/FILTERED FIELD RELATIONSHIPS section ──
        dep_relationships = []
        if isinstance(fields, list):
            for f in fields:
                label = f.get("label", "")
                # Dependent picklists
                ctrl = f.get("controllerName") or ""
                if ctrl and f.get("dependentPicklist"):
                    dep_relationships.append(f"  ⚠ {label} DEPENDS ON: {ctrl} (fill {ctrl} BEFORE {label})")
                # Filtered lookups
                filtered_info = f.get("filteredLookupInfo") or {}
                if isinstance(filtered_info, dict) and filtered_info.get("optionalFilter") is False:
                    controlling_fields = filtered_info.get("controllingFields") or []
                    if controlling_fields:
                        for cf in controlling_fields:
                            dep_relationships.append(f"  ⚠ {label} FILTERED BY: {cf} (fill {cf} BEFORE {label})")
                    else:
                        dep_relationships.append(f"  ⚠ {label} HAS MANDATORY LOOKUP FILTER (fill controlling fields first)")

        if dep_relationships:
            lines.append("")
            lines.append("=== FIELD DEPENDENCIES (CRITICAL — STEP ORDERING) ===")
            lines.append("The following fields depend on other fields. Controlling fields MUST be filled FIRST.")
            lines.extend(dep_relationships)
            lines.append("=== END FIELD DEPENDENCIES ===")

        return "\n".join(lines) if lines else "No field details available."

    # ── 5. Call Claude for fix suggestions ───────────────────────────────────
    @staticmethod
    async def generate_suggestions(
        failing_step: Dict,
        error_message: str,
        steps: List[Any],
        mcp_metadata: Optional[Dict],
        object_name: Optional[str],
        lookup_options: Optional[Dict] = None,
        chat_history: Optional[List[Dict]] = None,
        user_message: Optional[str] = None,
        previous_corrected_steps: Optional[List[Dict]] = None,
        user_edit_instruction: Optional[str] = None,
        run_logs: Optional[List[Dict]] = None,
    ) -> Dict:
        """
        Call Claude with the failure context.
        If previous_corrected_steps + user_edit_instruction are provided,
        runs in INTERACTIVE EDIT MODE (applies targeted edits only).
        Returns a dict with keys: analysis, corrected_steps
        """
        try:
            from app.core.config import settings
            import anthropic
        except ImportError:
            raise Exception("anthropic package not installed")

        if not settings.ANTHROPIC_API_KEY:
            raise Exception("ANTHROPIC_API_KEY not set")

        # ── INTERACTIVE EDIT MODE ──────────────────────────────────────────
        if previous_corrected_steps and user_edit_instruction:
            user_prompt = f"""═══ INTERACTIVE EDIT MODE ═══

The user wants to modify the existing corrected test steps.

User instruction: "{user_edit_instruction}"

=== CURRENT CORRECTED STEPS ===
{json.dumps(previous_corrected_steps, indent=2)}

=== YOUR TASK ===
Apply ONLY the user's requested change to the steps above.
Do NOT regenerate the whole test — just modify what was asked.
Output the FULL updated corrected_steps array with the change applied.
In "analysis", briefly describe what you changed.

Output ONLY a JSON object: {{"analysis": "...", "corrected_steps": [...]}}
No markdown, no code fences."""

            messages = []
            if chat_history:
                for msg in chat_history[-6:]:
                    messages.append({"role": msg.get("role", "user"), "content": msg.get("content", "")})
            messages.append({"role": "user", "content": user_prompt})

            client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
            response = await client.messages.create(
                model=HEALING_MODEL,
                max_tokens=4096,
                system=HEALING_SYSTEM_PROMPT,
                messages=messages,
                temperature=0.1,
            )

            content = (response.content[0].text or "").strip()
            if content.startswith("```"):
                content = "\n".join(
                    line for line in content.split("\n")
                    if not line.strip().startswith("```")
                )

            parsed = json.loads(content)
            if isinstance(parsed, dict) and "corrected_steps" in parsed:
                logger.info(f"[HEALING] Edit mode: applied '{user_edit_instruction[:60]}' → {len(parsed['corrected_steps'])} steps")
                return parsed
            raise ValueError(f"Unexpected edit-mode response: {type(parsed)}")

        # ── STANDARD HEALING MODE ──────────────────────────────────────────
        # Serialize steps for the prompt
        steps_list = []
        for i, s in enumerate(steps):
            if hasattr(s, "action"):
                steps_list.append({
                    "step_order": i + 1,
                    "action": s.action,
                    "target": s.target,
                    "value": getattr(s, "value", "") or "",
                    "locator_type": getattr(s, "locator_type", "") or "",
                })
            elif isinstance(s, dict):
                steps_list.append({
                    "step_order": i + 1,
                    "action": s.get("action", ""),
                    "target": s.get("target", ""),
                    "value": s.get("value", "") or "",
                    "locator_type": s.get("locator_type", "") or "",
                })

        metadata_str = TestHealingService._compact_metadata(mcp_metadata, lookup_options=lookup_options) if mcp_metadata else "Not available — infer required fields from the error message"

        required_fields_from_error = []
        if "required fields are missing" in error_message.lower():
            match = re.search(r'missing:\s*\[([^\]]+)\]', error_message, re.IGNORECASE)
            if match:
                required_fields_from_error = [f.strip() for f in match.group(1).split(",")]

        # Extract passing steps from run logs for context
        passing_log_steps = []
        if run_logs:
            for log in run_logs:
                if (log.get("status") or "").lower() in ("success", "passed"):
                    passing_log_steps.append({
                        "step_order": log.get("step_order", 0),
                        "action": log.get("action", ""),
                        "target": log.get("target", ""),
                        "value": log.get("value", ""),
                        "status": "PASSED",
                    })
                else:
                    break  # Stop at first failure

        user_prompt = f"""=== FAILED TEST CONTEXT ===
Failing step: #{failing_step.get('step_order', '?')} | action={failing_step.get('action', '?')} | target={failing_step.get('target', '?')}
Error: "{error_message}"
Salesforce Object: {object_name or 'Unknown (infer from navigate URL)'}

Required fields identified from the error message: {required_fields_from_error if required_fields_from_error else 'See error message above'}

=== CURRENT TEST STEPS ===
{json.dumps(steps_list, indent=2)}

=== RUN LOGS (showing which steps PASSED before failure) ===
The following steps PASSED in the actual test run. These workflow steps (navigate, search, click, wait, Edit) MUST be preserved in the corrected flow.
{json.dumps(passing_log_steps, indent=2) if passing_log_steps else 'No passing steps available.'}

=== MCP FIELD METADATA ({object_name}) ===
{metadata_str}

=== YOUR TASK ===
Fix ONLY the failing step and any missing required fields.
KEEP all the passing workflow steps (navigate, search, click record, wait, click Edit) exactly as they succeeded.
Do NOT skip the record-opening steps. You CANNOT fill fields on a list view.
Output ONLY the JSON object with 'analysis' and 'corrected_steps'. No markdown."""

        if user_message:
            user_prompt = f"Follow-up: {user_message}\n\n{user_prompt}"

        messages = []
        if chat_history:
            for msg in chat_history[-6:]:
                messages.append({"role": msg.get("role", "user"), "content": msg.get("content", "")})
        messages.append({"role": "user", "content": user_prompt})

        client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
        response = await client.messages.create(
            model=HEALING_MODEL,
            max_tokens=4096,
            system=HEALING_SYSTEM_PROMPT,
            messages=messages,
            temperature=0.2,
        )

        content = (response.content[0].text or "").strip()
        if content.startswith("```"):
            content = "\n".join(
                line for line in content.split("\n")
                if not line.strip().startswith("```")
            )

        parsed = json.loads(content)

        # Normalize: support both new {analysis, corrected_steps} and legacy list format
        if isinstance(parsed, dict) and "corrected_steps" in parsed:
            return parsed
        elif isinstance(parsed, list):
            return {"analysis": "Legacy format", "corrected_steps": [], "legacy_hints": parsed}
        else:
            raise ValueError(f"Unexpected LLM response format: {type(parsed)}")

    # ── 5b. Post-process: reorder corrected steps ────────────────────────────
    @staticmethod
    def _reorder_corrected_steps(steps: List[Dict], metadata: Optional[Dict] = None) -> List[Dict]:
        """
        Reorder corrected_steps so that:
        1. SELECT/LOOKUP fields come before TYPE fields
        2. Controlling fields come before dependent/filtered fields
        3. Navigate, click, wait steps stay in their original positions
        """
        if not steps or len(steps) < 2:
            return steps

        # Find the first form-fill step and the Save step to define the reorder range
        # IMPORTANT: Skip search-bar fills — only count real form field fills
        fill_start = None
        fill_end = None
        for i, s in enumerate(steps):
            action = (s.get("action") or "").lower()
            target = (s.get("target") or "").lower()
            if action in ("fill", "type", "select", "lookup", "lookup_select", "checkbox", "input"):
                # Skip search-bar fills
                if "search" in target:
                    continue
                if fill_start is None:
                    fill_start = i
                fill_end = i
            elif action == "click" and "save" in (s.get("target") or "").lower():
                if fill_start is not None and fill_end is not None:
                    break

        if fill_start is None or fill_end is None or fill_start >= fill_end:
            return steps

        # Validate: fill_start must be AFTER an Edit/New click
        # If it's before any Edit/New, the form range is wrong
        last_edit_new_idx = None
        for i in range(fill_start):
            s = steps[i]
            a = (s.get("action") or "").lower()
            t = (s.get("target") or "").lower()
            if a == "click" and ("edit" in t or "new" in t):
                last_edit_new_idx = i

        if last_edit_new_idx is None:
            # No Edit/New before first fill — can't safely reorder
            print(f"[HEALING] ⚠ Reorder skipped: no Edit/New click found before first form fill at index {fill_start}")
            return steps

        # Move fill_start to be after Edit/New click (don't include clicks/waits in form range)
        actual_fill_start = fill_start

        print(f"[HEALING] Reorder range: steps[{actual_fill_start}:{fill_end + 1}] out of {len(steps)} total")

        # Extract the form-fill range
        before = steps[:actual_fill_start]
        form_steps = steps[actual_fill_start:fill_end + 1]
        after = steps[fill_end + 1:]

        # Build dependency map from metadata
        dep_map = {}  # {dependent_label_lower: controlling_label_lower}
        if metadata:
            fields = metadata.get("fields", [])
            if isinstance(fields, list):
                label_map = {(f.get("name") or "").lower(): (f.get("label") or "").lower() for f in fields}
                for f in fields:
                    label = (f.get("label") or "").lower()
                    # Dependent picklists
                    ctrl = f.get("controllerName") or ""
                    if ctrl and f.get("dependentPicklist"):
                        ctrl_label = label_map.get(ctrl.lower(), ctrl.lower())
                        dep_map[label] = ctrl_label
                    # Filtered lookups
                    filtered_info = f.get("filteredLookupInfo") or {}
                    if isinstance(filtered_info, dict) and filtered_info.get("optionalFilter") is False:
                        controlling_fields = filtered_info.get("controllingFields") or []
                        for cf in controlling_fields:
                            cf_label = label_map.get(cf.lower(), cf.lower())
                            dep_map[label] = cf_label

        # Sort: SELECT/LOOKUP before TYPE, and controlling before dependent
        def sort_key(step):
            action = (step.get("action") or "").lower()
            target = (step.get("target") or "").lower()

            # Priority: 0 = controlling picklist/select, 1 = other picklist/select,
            #           2 = non-filtered lookup, 3 = filtered lookup, 4 = type/fill
            is_controlling = target in dep_map.values()
            is_dependent = target in dep_map

            if action in ("select", "fill") and is_controlling:
                return (0, target)
            elif action in ("select",):
                return (1, target)
            elif action in ("lookup", "lookup_select") and not is_dependent:
                return (2, target)
            elif action in ("lookup", "lookup_select") and is_dependent:
                return (3, target)
            elif action in ("fill", "type", "input"):
                return (4, target)
            else:
                return (5, target)

        sorted_form = sorted(form_steps, key=sort_key)

        # Renumber
        result = before + sorted_form + after
        for i, s in enumerate(result):
            s["step_order"] = i + 1

        # Log what changed
        original_order = [(s.get("target", ""), s.get("action", "")) for s in form_steps]
        new_order = [(s.get("target", ""), s.get("action", "")) for s in sorted_form]
        if original_order != new_order:
            print(f"[HEALING] ✅ Reordered form steps: controlling/lookup fields moved before type fields")
            logger.info(f"[HEALING] Reordered form steps")

        return result

    # ── 5c. Post-process: ensure workflow prefix (navigate/open/edit before form fields)
    @staticmethod
    def _ensure_workflow_prefix(corrected_steps: List[Dict], logs: List[Dict]) -> List[Dict]:
        """
        Extract the successful pre-failure workflow steps from run logs and
        ensure they appear at the start of corrected_steps.
        This prevents the healer from skipping navigate/search/click/Edit steps.
        """
        if not corrected_steps or not logs:
            return corrected_steps

        # ── Step A: Check if corrected_steps ALREADY has a valid workflow ──
        first_fill_idx = None
        for i, s in enumerate(corrected_steps):
            action = (s.get("action") or "").lower()
            target = (s.get("target") or "").lower()
            if action in ("fill", "lookup", "lookup_select", "select", "checkbox", "input"):
                if "search" not in target:
                    first_fill_idx = i
                    break

        if first_fill_idx is None:
            return corrected_steps  # No form fills → nothing to fix

        # Check if corrected_steps has Edit/New click before the first form fill
        has_edit_or_new = False
        for i in range(first_fill_idx):
            s = corrected_steps[i]
            action = (s.get("action") or "").lower()
            target = (s.get("target") or "").lower()
            if action == "click" and ("edit" in target or "new" in target):
                has_edit_or_new = True
                break

        if has_edit_or_new:
            # Workflow is OK — Claude preserved it
            print(f"[HEALING] Workflow check: corrected_steps has Edit/New before fill — OK")
            return corrected_steps

        print(f"[HEALING] ⚠ Workflow broken: first form-fill at index {first_fill_idx}, "
              f"no Edit/New click before it. Injecting workflow prefix from logs.")

        # ── Step B: Extract workflow prefix from the PASSING log steps ──
        prefix_steps = []
        for log in logs:
            status = (log.get("status") or "").lower()
            if status not in ("success", "passed"):
                break  # Stop at first failure
            action = (log.get("action") or "").lower()
            target = log.get("target") or ""
            value = log.get("value") or ""

            # Include workflow steps only (navigate, click, wait, search fills)
            if action in ("fill", "lookup", "lookup_select", "select", "checkbox", "input"):
                if "search" in target.lower() or "search" in value.lower():
                    prefix_steps.append({
                        "step_order": len(prefix_steps) + 1,
                        "action": log.get("action", ""),
                        "target": target,
                        "value": value,
                        "locator_type": log.get("locator_type", ""),
                    })
                    continue
                else:
                    break  # Real form field — stop collecting

            prefix_steps.append({
                "step_order": len(prefix_steps) + 1,
                "action": log.get("action", ""),
                "target": target,
                "value": value,
                "locator_type": log.get("locator_type", ""),
            })

        # ── Step C: If logs provide a prefix with Edit/New, use it directly ──
        prefix_has_edit_or_new = any(
            (s.get("action") or "").lower() == "click"
            and ("edit" in (s.get("target") or "").lower() or "new" in (s.get("target") or "").lower())
            for s in prefix_steps
        )

        if prefix_has_edit_or_new:
            # Logs have the good workflow (navigate → search → click → Edit)
            # Use it as the prefix, replace everything before first form fill
            form_and_rest = corrected_steps[first_fill_idx:]
            result = prefix_steps + form_and_rest
            for i, s in enumerate(result):
                s["step_order"] = i + 1
            print(f"[HEALING] ✅ Injected {len(prefix_steps)} workflow steps from logs "
                  f"(had Edit/New) before form fields")
            return result

        # ── Step D: Logs don't have Edit/New either — inject click New + wait ── 
        print(f"[HEALING] ⚠ Logs only have {len(prefix_steps)} prefix steps (no Edit/New) — "
              f"injecting 'click New' + 'wait 2000'")
        new_prefix = list(prefix_steps) if prefix_steps else [{
            "step_order": 1,
            "action": "navigate",
            "target": "",
            "value": corrected_steps[0].get("value", "/lightning/o/Invoice__c/list"),
            "locator_type": "url",
        }]
        new_prefix.append({
            "step_order": len(new_prefix) + 1,
            "action": "click",
            "target": "role=button, name=New",
            "value": "",
            "locator_type": "role",
        })
        new_prefix.append({
            "step_order": len(new_prefix) + 1,
            "action": "wait",
            "target": "2000",
            "value": "",
            "locator_type": "",
        })

        form_and_rest = corrected_steps[first_fill_idx:]
        result = new_prefix + form_and_rest
        for i, s in enumerate(result):
            s["step_order"] = i + 1
        print(f"[HEALING] ✅ Injected {len(new_prefix)} workflow prefix steps "
              f"(navigate + New + wait) before form fields")
        return result

    # ── 5d. Post-process: validate step order (Edit vs New, PDF after Save) ──
    @staticmethod
    def _validate_step_order(steps: List[Dict]) -> List[Dict]:
        """
        Fix step ordering issues:
        1. Replace 'click New' with 'click Edit' + wait when test opens an existing record
        2. Move 'Generate PDF' / action buttons to AFTER Save
        """
        if not steps or len(steps) < 3:
            return steps

        # ── Fix 1: Replace 'click New' with 'click Edit' for edit flows ──
        has_search = any(
            "search" in (s.get("target") or "").lower()
            or "search" in (s.get("value") or "").lower()
            for s in steps
        )
        has_record_link = any(
            (s.get("action") or "").lower() == "click"
            and "role=link" in (s.get("target") or "").lower()
            for s in steps
        )
        is_edit_flow = has_search and has_record_link

        if is_edit_flow:
            for i, s in enumerate(steps):
                action = (s.get("action") or "").lower()
                target = (s.get("target") or "").lower()
                if action == "click" and "new" in target and "role=button" in target:
                    print(f"[HEALING] ✅ Replaced 'click New' → 'click Edit' at step #{i+1}")
                    steps[i] = {
                        "step_order": i + 1,
                        "action": "click",
                        "target": "button[name='Edit']",
                        "value": "",
                        "locator_type": "css",
                    }
                    # Ensure there's a wait after Edit
                    if i + 1 < len(steps):
                        next_action = (steps[i + 1].get("action") or "").lower()
                        if next_action != "wait":
                            steps.insert(i + 1, {
                                "step_order": i + 2,
                                "action": "wait",
                                "target": "2000",
                                "value": "",
                                "locator_type": "",
                            })
                    break
                elif action == "click" and "edit" in target and "role=button" in target:
                    print(f"[HEALING] ✅ Upgraded generic 'role=button, name=Edit' to 'button[name=Edit]' at step #{i+1}")
                    steps[i]["target"] = "button[name='Edit']"
                    steps[i]["locator_type"] = "css"
                    break

        # ── Fix 2: Move "Generate PDF" buttons AFTER Save ──
        pdf_keywords = ["generate", "pdf"]
        pdf_idx = None
        save_idx = None
        first_fill_idx = None

        for i, s in enumerate(steps):
            action = (s.get("action") or "").lower()
            target = (s.get("target") or "").lower()
            if action == "click" and any(kw in target for kw in pdf_keywords):
                if pdf_idx is None:
                    pdf_idx = i
            elif action == "click" and "save" in target:
                save_idx = i
            elif action in ("fill", "lookup", "lookup_select", "select", "type", "input"):
                if "search" not in target and first_fill_idx is None:
                    first_fill_idx = i

        if pdf_idx is not None and first_fill_idx is not None and save_idx is not None:
            if pdf_idx < first_fill_idx:
                # Collect PDF block (click + following asserts/waits)
                pdf_block = [steps[pdf_idx]]
                remove_end = pdf_idx + 1
                while remove_end < len(steps):
                    na = (steps[remove_end].get("action") or "").lower()
                    if na in ("assert_text", "wait"):
                        pdf_block.append(steps[remove_end])
                        remove_end += 1
                    else:
                        break

                # Remove PDF block
                for _ in range(remove_end - pdf_idx):
                    steps.pop(pdf_idx)

                # Find new Save index
                new_save_idx = None
                for i, s in enumerate(steps):
                    if (s.get("action") or "").lower() == "click" and "save" in (s.get("target") or "").lower():
                        new_save_idx = i
                        break

                insert_pos = (new_save_idx + 1) if new_save_idx is not None else len(steps)

                # Add wait before PDF
                steps.insert(insert_pos, {
                    "step_order": 0, "action": "wait", "target": "3000",
                    "value": "", "locator_type": "",
                })
                insert_pos += 1

                for bs in pdf_block:
                    steps.insert(insert_pos, bs)
                    insert_pos += 1

                print(f"[HEALING] ✅ Moved 'Generate PDF' block ({len(pdf_block)} steps) to after Save")

        # Renumber
        for i, s in enumerate(steps):
            s["step_order"] = i + 1
        return steps

    # ── 6. Main entry point: called from test run pipeline ───────────────────
    @staticmethod
    async def generate_healing_suggestions(
        logs: List[Dict],
        steps: List[Any],
        project_id: str,
        db_session,
    ) -> Optional[List[Dict]]:
        """
        Top-level method called after a test run fails.
        Returns list of suggestion dicts, or None if no app-level errors found.
        """
        try:
            # Step 1: detect app error
            error_info = TestHealingService.detect_app_errors(logs)
            if not error_info:
                logger.info("[HEALING] No application-level error detected in logs — skipping")
                return None

            logger.info(f"[HEALING] App error detected at step #{error_info['step_order']}: {error_info['error_message'][:100]}")
            print(f"[HEALING] App error detected at step #{error_info['step_order']}")

            # Step 2: infer object
            object_name = TestHealingService.infer_object_name(logs, steps)
            logger.info(f"[HEALING] Inferred object: {object_name}")

            # Step 3: fetch metadata
            mcp_metadata = None
            lookup_options: Dict[str, List[str]] = {}
            if object_name and project_id:
                mcp_metadata = await TestHealingService.fetch_object_metadata(
                    object_name, project_id, db_session
                )
                logger.info(f"[HEALING] MCP metadata fetched: {bool(mcp_metadata)}")
                print(f"[HEALING] MCP metadata fetched: {bool(mcp_metadata)}, fields: {len((mcp_metadata or {}).get('fields', []))}")

                # Step 3b: query real record names for each lookup field
                if mcp_metadata:
                    lookup_options = await TestHealingService.fetch_lookup_values(
                        mcp_metadata, project_id, db_session
                    )
                    print(f"[HEALING] Lookup options for fields: {list(lookup_options.keys())} = {lookup_options}")
                    logger.info(f"[HEALING] Lookup options for fields: {list(lookup_options.keys())}")

            # Step 4: generate suggestions via Claude
            heal_result = await TestHealingService.generate_suggestions(
                failing_step=error_info["failing_step"],
                error_message=error_info["error_message"],
                steps=steps,
                mcp_metadata=mcp_metadata,
                object_name=object_name,
                lookup_options=lookup_options,
                run_logs=logs,
            )

            # Step 5: post-process — ensure workflow prefix from logs
            if heal_result and heal_result.get("corrected_steps"):
                cs = heal_result["corrected_steps"]
                print(f"[HEALING] 🔍 BEFORE workflow prefix ({len(cs)} steps):")
                for s in cs[:6]:
                    print(f"  #{s.get('step_order','?')} {s.get('action','?')} target={s.get('target','')[:40]} value={s.get('value','')[:30]}")
                heal_result["corrected_steps"] = TestHealingService._ensure_workflow_prefix(
                    heal_result["corrected_steps"],
                    logs=logs,
                )
                cs = heal_result["corrected_steps"]
                print(f"[HEALING] 🔍 AFTER workflow prefix ({len(cs)} steps):")
                for s in cs[:8]:
                    print(f"  #{s.get('step_order','?')} {s.get('action','?')} target={s.get('target','')[:40]} value={s.get('value','')[:30]}")

            # Step 5b: post-process — reorder form-fill steps (controlling fields before dependent)
            if heal_result and heal_result.get("corrected_steps"):
                heal_result["corrected_steps"] = TestHealingService._reorder_corrected_steps(
                    heal_result["corrected_steps"],
                    metadata=mcp_metadata,
                )
                cs = heal_result["corrected_steps"]
                print(f"[HEALING] 🔍 AFTER reorder ({len(cs)} steps):")
                for s in cs[:8]:
                    print(f"  #{s.get('step_order','?')} {s.get('action','?')} target={s.get('target','')[:40]} value={s.get('value','')[:30]}")

            # Step 5c: post-process — validate step order (Edit vs New, PDF after Save)
            if heal_result and heal_result.get("corrected_steps"):
                heal_result["corrected_steps"] = TestHealingService._validate_step_order(
                    heal_result["corrected_steps"],
                )
                cs = heal_result["corrected_steps"]
                print(f"[HEALING] 🔍 AFTER validate order ({len(cs)} steps):")
                for s in cs[:10]:
                    print(f"  #{s.get('step_order','?')} {s.get('action','?')} target={s.get('target','')[:40]} value={s.get('value','')[:30]}")

            n = len((heal_result or {}).get("corrected_steps", []))
            logger.info(f"[HEALING] Generated corrected_steps with {n} steps")
            return heal_result

        except Exception as e:
            logger.warning(f"[HEALING] generate_healing_suggestions failed (non-critical): {e}")
            return None

    # ── 7. Conversational chat handler ────────────────────────────────────────

    # Patterns that indicate the user wants to EDIT steps (not just ask a question)
    EDIT_PATTERNS = [
        r'(?:update|change|set|modify|edit)\s+step\s+\d+',
        r'step\s+\d+.*(?:to|as|=)',
        r'(?:swap|switch|move)\s+step',
        r'(?:add|insert)\s+(?:a\s+)?(?:wait|step)',
        r'(?:remove|delete)\s+step\s+\d+',
        r'(?:make|change)\s+step\s+\d+.*(?:action|lookup|fill|select|click|type)',
        r'(?:reorder|rearrange)',
    ]

    @staticmethod
    def _is_edit_instruction(message: str) -> bool:
        """Check if user message is a step-edit instruction."""
        msg_lower = message.lower().strip()
        for pattern in TestHealingService.EDIT_PATTERNS:
            if re.search(pattern, msg_lower):
                return True
        return False

    @staticmethod
    async def chat(
        run_id: str,
        user_message: str,
        chat_history: List[Dict],
        logs: List[Dict],
        steps: List[Any],
        project_id: str,
        db_session,
        current_corrected_steps: Optional[List[Dict]] = None,
    ) -> Dict:
        """
        Handle a follow-up chat message from the user.
        If the message is an edit instruction and current_corrected_steps is provided,
        runs in INTERACTIVE EDIT MODE — applies the change and returns updated steps.
        Otherwise, operates as a Q&A chatbot about the failure.
        Returns {reply: str, corrected_steps: [...] or None}
        """
        is_edit = TestHealingService._is_edit_instruction(user_message)

        # ── INTERACTIVE EDIT MODE ──────────────────────────────────────────
        if is_edit and current_corrected_steps:
            logger.info(f"[HEALING] Edit mode: '{user_message[:80]}'")
            try:
                result = await TestHealingService.generate_suggestions(
                    failing_step={},
                    error_message="",
                    steps=steps,
                    mcp_metadata=None,
                    object_name=None,
                    chat_history=chat_history,
                    previous_corrected_steps=current_corrected_steps,
                    user_edit_instruction=user_message,
                )
                analysis = result.get("analysis", "Changes applied.")
                corrected = result.get("corrected_steps", current_corrected_steps)
                return {
                    "reply": f"✅ {analysis}",
                    "corrected_steps": corrected,
                }
            except Exception as e:
                logger.warning(f"[HEALING] Edit mode failed: {e}")
                return {
                    "reply": f"Sorry, I couldn't apply that edit: {str(e)}. Please try rephrasing.",
                    "corrected_steps": current_corrected_steps,
                }

        # ── STANDARD Q&A MODE ──────────────────────────────────────────────
        error_info = TestHealingService.detect_app_errors(logs)
        object_name = TestHealingService.infer_object_name(logs, steps)

        mcp_metadata = None
        if object_name and project_id:
            mcp_metadata = await TestHealingService.fetch_object_metadata(
                object_name, project_id, db_session
            )

        try:
            result = await TestHealingService.generate_suggestions(
                failing_step=error_info["failing_step"] if error_info else {},
                error_message=error_info["error_message"] if error_info else "",
                steps=steps,
                mcp_metadata=mcp_metadata,
                object_name=object_name,
                chat_history=chat_history,
                user_message=user_message,
            )
            analysis = result.get("analysis", "")
            corrected = result.get("corrected_steps", [])
            return {
                "reply": f"{analysis}" if analysis else "Here are updated suggestions.",
                "corrected_steps": corrected if corrected else None,
            }
        except Exception as e:
            logger.warning(f"[HEALING] Chat Q&A failed: {e}")
            return {
                "reply": f"Sorry, I couldn't process that: {str(e)}",
                "corrected_steps": None,
            }
