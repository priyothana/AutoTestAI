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
]

# ── Claude model for healing (Sonnet is fast + accurate enough) ───────────────
HEALING_MODEL = "claude-sonnet-4-20250514"

# ── System prompt for the AI Fix Assistant ────────────────────────────────────
HEALING_SYSTEM_PROMPT = """You are an expert Salesforce Lightning + Playwright test architect.

A test failed because required fields were missing when a Salesforce record was saved.
Your job is to produce a COMPLETE, CORRECTED test steps array that will run successfully end-to-end.

═══ LOCATOR FORMAT REFERENCE (use these EXACTLY) ═══

For CLICK on a button:
  {"action":"click","target":"role=button, name=Edit","value":"","locator_type":"role"}
  {"action":"click","target":"role=button, name=Save","value":"","locator_type":"role"}
  {"action":"click","target":"role=button, name=Generate Invoice PDF","value":"","locator_type":"role"}

For CLICK on a link (record row):
  {"action":"click","target":"role=link, name=DS-2023-24-0025","value":"","locator_type":"role"}

For NAVIGATE:
  {"action":"navigate","target":"","value":"/lightning/o/Invoice__c/list","locator_type":"url"}

For FILL a field by label:
  {"action":"fill","target":"Pay To","value":"...","locator_type":"label"}

For WAIT (milliseconds):
  {"action":"wait","target":"2000","value":"","locator_type":""}

For ASSERT TEXT on element:
  {"action":"assert_text","target":"Files","value":"","locator_type":"text"}
  {"action":"assert_text","target":"css=.previewOuterContainer, canvas, iframe[src*='pdf'], .pdfViewer","value":"","locator_type":"css"}

═══ CRITICAL SALESFORCE WORKFLOW RULES ═══

1. After clicking a record link, INSERT A WAIT of 2000ms before the Edit button click
   so the record page has time to fully load — otherwise the Edit button is not found.

2. REQUIRED FIELDS must be filled on the RECORD EDIT FORM — NOT inside a PDF modal or popup.
   In Salesforce Lightning, the correct flow to edit a record is:
   a) Open the record: click role=link
   b) WAIT 2000ms for the page to load
   c) Click Edit: {"action":"click","target":"role=button, name=Edit","value":"","locator_type":"role"}
   d) FILL each required field using its exact label with locator_type="label"
   e) Click Save: {"action":"click","target":"role=button, name=Save","value":"","locator_type":"role"}
   f) THEN proceed to Generate Invoice PDF, assert PDF, click Save (PDF), assert Files

3. NEVER insert fill steps inside a PDF modal or preview.

4. For LOOKUP fields (Pay To, Entity): use action="fill" with locator_type="label".
   Add wait 1000ms AFTER each lookup fill to allow dropdown autocomplete to dismiss.

5. For PICKLIST fields: use action="fill" with the exact picklist value from MCP metadata.

6. For DATE fields: use ISO format (YYYY-MM-DD) with realistic date ranges.

═══ OUTPUT FORMAT ═══

Output ONLY a single JSON object, no markdown, no code fences:
{
  "analysis": "<one sentence: what was wrong and what you changed>",
  "corrected_steps": [
    {"step_order":1,"action":"navigate","target":"","value":"/lightning/o/Invoice__c/list","locator_type":"url"},
    {"step_order":2,"action":"click","target":"role=link, name=DS-2023-24-0025","value":"","locator_type":"role"},
    {"step_order":3,"action":"wait","target":"2000","value":"","locator_type":""},
    {"step_order":4,"action":"click","target":"role=button, name=Edit","value":"","locator_type":"role"},
    ...continue with fill steps and rest of flow...
  ]
}

Include EVERY step from start to finish. The corrected_steps array must be complete and runnable.
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
                # Use first referenced object type (most lookups have one)
                ref_object = ref_to[0] if ref_to else None
                if not ref_object:
                    continue

                # Cache per-object queries
                if ref_object not in queried_objects:
                    try:
                        # Determine the name field — most objects have 'Name', some have different
                        name_field = "Name"
                        if ref_object == "RecordType":
                            name_field = "Name"
                        elif ref_object == "User":
                            name_field = "Name"

                        soql = f"SELECT Id, {name_field} FROM {ref_object} WHERE {name_field} != null LIMIT 5"
                        result = SalesforceMCPService.query(
                            username=username,
                            password=password,
                            security_token=security_token,
                            domain=domain,
                            soql=soql,
                        )
                        # query() returns {"total_size": N, "done": True, "records": [...]}
                        records = result.get("records", []) if isinstance(result, dict) else (result or [])
                        names = [
                            r.get(name_field, "") for r in records
                            if r.get(name_field)
                        ]
                        queried_objects[ref_object] = names
                        logger.info(f"[HEALING] Lookup '{label}' → {ref_object}: found {len(names)} records: {names}")
                    except Exception as qe:
                        logger.warning(f"[HEALING] Could not query {ref_object} for lookup '{label}': {qe}")
                        queried_objects[ref_object] = []

                names = queried_objects.get(ref_object, [])
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
                    if isinstance(pv, list) and pv and isinstance(pv[0], str):
                        pv_str = f" | values: {', '.join(pv[:6])}"
                    else:
                        pv_str = ""
                    lines.append(f"  - {label} ({api}) [picklist, {req}]{pv_str}")

                elif ftype == "reference":
                    # Show REAL existing record names from the org if available
                    real_names = (lookup_options or {}).get(label, [])
                    ref_to = f.get("referenceTo") or []
                    ref_str = f" → refs: {', '.join(ref_to)}" if ref_to else ""
                    if real_names:
                        lines.append(
                            f"  - {label} ({api}) [lookup, {req}]{ref_str}"
                            f" | USE ONE OF THESE REAL ORG VALUES: {', '.join(repr(n) for n in real_names)}"
                        )
                    else:
                        lines.append(f"  - {label} ({api}) [lookup, {req}]{ref_str} | query org for real value")

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
    ) -> Dict:
        """
        Call Claude with the failure context.
        Returns a dict with keys: analysis, corrected_steps, suggestions_summary
        """
        try:
            from app.core.config import settings
            import anthropic
        except ImportError:
            raise Exception("anthropic package not installed")

        if not settings.ANTHROPIC_API_KEY:
            raise Exception("ANTHROPIC_API_KEY not set")

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
            # Extract field names from error like: "Required fields are missing: [Pay To, Entity, ...]"
            match = re.search(r'missing:\s*\[([^\]]+)\]', error_message, re.IGNORECASE)
            if match:
                required_fields_from_error = [f.strip() for f in match.group(1).split(",")]

        user_prompt = f"""=== FAILED TEST CONTEXT ===
Failing step: #{failing_step.get('step_order', '?')} | action={failing_step.get('action', '?')} | target={failing_step.get('target', '?')}
Error: "{error_message}"
Salesforce Object: {object_name or 'Unknown (infer from navigate URL)'}

Required fields identified from the error message: {required_fields_from_error if required_fields_from_error else 'See error message above'}

=== CURRENT TEST STEPS ===
{json.dumps(steps_list, indent=2)}

=== MCP FIELD METADATA ({object_name}) ===
{metadata_str}

=== YOUR TASK ===
Produce the complete corrected test steps following the Salesforce workflow rules.
The test should: navigate to the list, open the record, click Edit, fill ALL required fields, save the record, then proceed to Generate Invoice PDF, assert the PDF, save to files, and assert the file.

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
            # Legacy insert-hint format — wrap it as-is for backward compat
            return {"analysis": "Legacy format", "corrected_steps": [], "legacy_hints": parsed}
        else:
            raise ValueError(f"Unexpected LLM response format: {type(parsed)}")

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

                # Step 3b: query real record names for each lookup field
                if mcp_metadata:
                    lookup_options = await TestHealingService.fetch_lookup_values(
                        mcp_metadata, project_id, db_session
                    )
                    logger.info(f"[HEALING] Lookup options for fields: {list(lookup_options.keys())}")

            # Step 4: generate suggestions via Claude
            heal_result = await TestHealingService.generate_suggestions(
                failing_step=error_info["failing_step"],
                error_message=error_info["error_message"],
                steps=steps,
                mcp_metadata=mcp_metadata,
                object_name=object_name,
                lookup_options=lookup_options,
            )

            n = len((heal_result or {}).get("corrected_steps", []))
            logger.info(f"[HEALING] Generated corrected_steps with {n} steps")
            return heal_result

        except Exception as e:
            logger.warning(f"[HEALING] generate_healing_suggestions failed (non-critical): {e}")
            return None

    # ── 7. Conversational chat handler ────────────────────────────────────────
    @staticmethod
    async def chat(
        run_id: str,
        user_message: str,
        chat_history: List[Dict],
        logs: List[Dict],
        steps: List[Any],
        project_id: str,
        db_session,
    ) -> Dict:
        """
        Handle a follow-up chat message from the user.
        Returns {reply: str, suggestions: [...], updated_steps: [...] or None}
        """
        error_info = TestHealingService.detect_app_errors(logs)
        object_name = TestHealingService.infer_object_name(logs, steps)

        mcp_metadata = None
        if object_name and project_id:
            mcp_metadata = await TestHealingService.fetch_object_metadata(
                object_name, project_id, db_session
            )

        # Generate new suggestions based on user message
        suggestions = await TestHealingService.generate_suggestions(
            failing_step=error_info["failing_step"] if error_info else {},
            error_message=error_info["error_message"] if error_info else "",
            steps=steps,
            mcp_metadata=mcp_metadata,
            object_name=object_name,
            chat_history=chat_history,
            user_message=user_message,
        )

        # Build a human-readable reply
        reply_lines = [f"Here are updated fix suggestions based on your input:"]
        for i, s in enumerate(suggestions, 1):
            ns = s.get("new_step", {})
            reply_lines.append(f"{i}. {s.get('type','').replace('_',' ').title()}: {ns.get('action','').upper()} \"{ns.get('target','')}\" = \"{ns.get('value','')}\" — {s.get('reason','')}")

        return {
            "reply": "\n".join(reply_lines),
            "suggestions": suggestions,
        }
