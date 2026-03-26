from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import List, Dict, Any, Optional
from uuid import UUID
import openai

from app.db.session import get_db
from app.models.test_case import TestCase
from app.schemas.test_case import TestCaseCreate, TestCaseResponse, StepModel
from app.services.ai_service import AIService

router = APIRouter()

@router.post("/generate-test-steps", response_model=Dict[str, Any])
async def generate_test_steps_endpoint(
    prompt_data: Dict[str, str],
    db: AsyncSession = Depends(get_db),
):
    prompt = prompt_data.get("prompt")
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")

    provider = prompt_data.get("provider", "openai")
    model = prompt_data.get("model")
    project_id = prompt_data.get("project_id")

    # --- Gate login step generation and detect MCP projects ---
    session_instruction = ""
    use_mcp_rag = False

    if project_id:
        try:
            from app.models.project import Project
            from app.models.project_integration import ProjectIntegration
            from app.services.session_service import SessionService

            pid = UUID(project_id)
            proj_result = await db.execute(select(Project).where(Project.id == pid))
            project = proj_result.scalars().first()

            if project:
                int_result = await db.execute(
                    select(ProjectIntegration).where(ProjectIntegration.project_id == pid)
                )
                integration = int_result.scalars().first()
                is_connected = integration and integration.status == "connected"
                is_mcp = integration and getattr(integration, 'mcp_connected', False)

                # --- MCP + Metadata → Strict metadata-driven RAG generation ---
                # This check runs for ANY project category with MCP connection
                if is_mcp and is_connected:
                    from sqlalchemy import func as sa_func
                    from app.models.vector_embedding import VectorEmbedding
                    embedding_count = (await db.execute(
                        select(sa_func.count()).select_from(VectorEmbedding).where(
                            VectorEmbedding.project_id == pid
                        )
                    )).scalar_one()

                    if embedding_count > 0:
                        use_mcp_rag = True
                        print(f"[TEST-GEN] MCP project {pid} has {embedding_count} embeddings → using strict metadata RAG")
                    else:
                        session_instruction = (
                            "\n\nIMPORTANT: This is a Salesforce MCP-connected project. "
                            "DO NOT generate any login/authentication steps. The user is already authenticated. "
                            "Start the test from the Lightning home page or the relevant object page directly. "
                            "Use Salesforce Lightning URL patterns like /lightning/o/ObjectName/list."
                        )

                elif project.category == "salesforce" and is_connected:
                    session_instruction = (
                        "\n\nIMPORTANT: This is a Salesforce project with an active OAuth connection. "
                        "DO NOT generate any login/authentication steps. The user is already authenticated. "
                        "Start the test from the application's home page or the relevant object page directly."
                    )
                elif project.category == "salesforce":
                    has_session = await SessionService.has_valid_session(db, pid)
                    if has_session:
                        session_instruction = (
                            "\n\nIMPORTANT: This Salesforce project has an active browser session. "
                            "DO NOT include login/authentication steps. The session will be reused automatically. "
                            "Start the test from the Lightning home page or the relevant object page."
                        )
        except Exception as e:
            print(f"[TEST-GEN] Project detection error: {e}")
            pass  # Non-critical; fall back to normal generation

    # --- MCP RAG path: strict metadata-driven generation ---
    if use_mcp_rag:
        try:
            from app.services.rag_service import RAGService

            retrieved_chunks = await RAGService.retrieve(
                db=db,
                project_id=UUID(project_id),
                query_text=prompt,
                top_k=15,
            )

            if retrieved_chunks:
                # --- Filter chunks to target object only ---
                # Extract object name from user prompt to filter out unrelated metadata
                import re as _re
                prompt_lower = prompt.lower()
                # Strategy 1: Standard patterns
                target_obj = None
                meta_records = []  # Initialize — will be populated later in the metadata query
                for pattern in [
                    r'(?:create|new|edit|update|delete|view|open|test)\s+(?:(?:a|an|the)\s+)?(?:new\s+)?(\w[\w\s]*?)(?:\s+record|\s+for|\s+with|\s+-|\s*$)',
                    r'(?:creat\w*|new)\s+(?:(?:a|an|the)\s+)?(?:new\s+)?(\w+)',  # handles typos like "craete"
                    r'\b(\w+)\s+(?:creation|form|page|layout|list)\b',
                ]:
                    obj_match = _re.search(pattern, prompt_lower)
                    if obj_match:
                        candidate = obj_match.group(1).strip()
                        if candidate and candidate not in ('a', 'an', 'the', 'new', 'test', 'record'):
                            target_obj = candidate
                            break

                # Strategy 2: Match words in prompt against known metadata object names
                if not target_obj and meta_records:
                    obj_name_set = {}
                    for record in meta_records:
                        structured = record.structured_json or {}
                        obj_name = structured.get("object", record.object_name)
                        if obj_name:
                            obj_name_set[obj_name.lower()] = obj_name
                            label = structured.get("label", "").lower()
                            if label:
                                obj_name_set[label] = obj_name
                    prompt_words = set(prompt_lower.split())
                    for key, real_name in obj_name_set.items():
                        if key in prompt_words or key in prompt_lower:
                            target_obj = key
                            print(f"[TEST-GEN] Object matched via metadata scan: '{key}' → '{real_name}'")
                            break

                print(f"[TEST-GEN] Detected target object: '{target_obj}' from prompt: '{prompt_lower[:80]}'")


                if target_obj:
                    # ── Strict chunk filtering: separate metadata from learning ──
                    # Metadata chunks from other objects cause the LLM to generate
                    # steps for fields that don't belong to the target object.
                    # Keep: execution learning chunks (useful across objects)
                    # Keep: metadata chunks ABOUT the target object only
                    # Drop: metadata chunks about other objects
                    learning_chunks = []
                    target_meta_chunks = []
                    for c in retrieved_chunks:
                        c_lower = c.lower()
                        # Execution learning chunks — always keep
                        if (c_lower.startswith("field behavior rules") or
                            c_lower.startswith("successful test execution") or
                            c_lower.startswith("failure correction")):
                            learning_chunks.append(c)
                            continue
                        # Metadata chunks — strict object matching
                        # Check if the chunk is primarily ABOUT the target object
                        # by looking at the first 100 chars (chunk header)
                        chunk_header = c_lower[:150]
                        if (target_obj in chunk_header or
                            f"object: {target_obj}" in c_lower[:300] or
                            f"fields for {target_obj}" in c_lower[:300]):
                            target_meta_chunks.append(c)

                    filtered = target_meta_chunks + learning_chunks
                    if filtered:
                        print(f"[TEST-GEN] Strict filter: {len(retrieved_chunks)} chunks → "
                              f"{len(target_meta_chunks)} metadata + {len(learning_chunks)} learning "
                              f"for object '{target_obj}'")
                        retrieved_chunks = filtered
                    else:
                        print(f"[TEST-GEN] No chunks matched strict filter for '{target_obj}', "
                              f"using all {len(retrieved_chunks)} chunks")

                rag_context = await RAGService.build_rag_context(retrieved_chunks)

                # --- Supplement with DIRECT metadata for ALL fields ---
                # RAG chunks may not contain all required field details
                try:
                    from app.models.metadata_normalized import MetadataNormalized

                    meta_result = await db.execute(
                        select(MetadataNormalized).where(
                            MetadataNormalized.project_id == UUID(project_id),
                            MetadataNormalized.entity_type == "object",
                        )
                    )
                    meta_records = meta_result.scalars().all()

                    # ─── Extract explicit field-value pairs from user prompt ───
                    import re as _re3
                    # Build a map of all metadata field labels → field info
                    all_meta_fields = {}
                    for record in meta_records:
                        structured = record.structured_json or {}
                        for f in structured.get("fields", []):
                            lbl = f.get("label", "")
                            if lbl:
                                all_meta_fields[lbl.lower()] = f

                    # Parse field-value pairs from user prompt using multiple patterns
                    extracted_pairs = []
                    # Strategy: For each metadata field label, check if it appears
                    # in the user's prompt with an associated quoted value
                    for flabel, finfo in all_meta_fields.items():
                        actual_label = finfo.get("label", "")
                        if not actual_label or len(actual_label) < 4:
                            continue
                        # Check for: Field "Value" or Field as "Value" (case-insensitive)
                        # Use word boundary to prevent 'Type' matching inside 'Tax Type'
                        escaped = _re3.escape(actual_label)
                        patterns = [
                            _re3.compile(
                                r'(?:^|,\s*)' + escaped + r'\s+as\s+["\u201c]([^"\u201d]+)["\u201d]',
                                _re3.IGNORECASE
                            ),
                            _re3.compile(
                                r'(?:^|,\s*)' + escaped + r'\s+["\u201c]([^"\u201d]+)["\u201d]',
                                _re3.IGNORECASE
                            ),
                            _re3.compile(
                                r'(?:for\s+(?:an?\s+)?)' + escaped + r'\s+["\u201c]([^"\u201d]+)["\u201d]',
                                _re3.IGNORECASE
                            ),
                        ]
                        for pat in patterns:
                            m = pat.search(prompt)
                            if m:
                                fval = m.group(1).strip()
                                if not any(p[0].lower() == actual_label.lower() for p in extracted_pairs):
                                    extracted_pairs.append((actual_label, fval))
                                break

                    # Match extracted field names to metadata labels
                    matched_extractions = []
                    for fname, fval in extracted_pairs:
                        meta_field = all_meta_fields.get(fname.lower())
                        if meta_field:
                            ftype = meta_field.get("type", "string")
                            if ftype == "reference":
                                action = "LOOKUP"
                            elif ftype in ("picklist", "multipicklist", "combobox"):
                                action = "SELECT"
                            else:
                                action = "TYPE"
                            matched_extractions.append((meta_field.get("label", fname), fval, action, ftype))

                    if matched_extractions:
                        print(f"[TEST-GEN] Extracted field-value pairs: {[(f, v) for f, v, _, _ in matched_extractions]}")

                    field_summary_lines = [
                        "\n\n=== COMPLETE FIELD REFERENCE (Direct from Org Metadata) ===",
                        "⚠ CRITICAL OVERRIDE: IGNORE any field information from the RAG context above.",
                        "The RAG context may contain fields from MULTIPLE objects — DO NOT use them.",
                        "Use ONLY the fields listed in THIS section. These are the ONLY valid fields.",
                        "",
                        "RULES:",
                        "  1. Generate steps for ALL fields marked [REQUIRED] below",
                        "  2. Generate steps for fields marked [RECOMMENDED] below (commonly required on page layout)",
                        "  3. Generate steps for fields the user explicitly mentions in their prompt",
                        "  4. DO NOT generate steps for [OPTIONAL] fields unless user mentions them",
                        "  5. DO NOT generate steps for fields from other objects",
                        "IMPORTANT: Use the exact LABEL as the step target.",
                        "IMPORTANT: Use the correct ACTION by TYPE (picklist→SELECT, reference→LOOKUP, text/date→TYPE).",
                        "",
                    ]

                    # Add extracted field-value pairs at the VERY TOP
                    if matched_extractions:
                        field_summary_lines.append("=== EXTRACTED FIELDS FROM USER PROMPT (YOU MUST GENERATE A STEP FOR EACH) ===")
                        for flabel, fval, faction, ftype in matched_extractions:
                            field_summary_lines.append(
                                f"  [MANDATORY] Field=\"{flabel}\" | Value=\"{fval}\" | Action={faction} | Type={ftype}"
                            )
                        field_summary_lines.append("=== END EXTRACTED FIELDS ===")
                        field_summary_lines.append("")

                    # Two-pass object filter: prefer exact match, fall back to substring
                    obj_name_map = {}
                    for record in meta_records:
                        structured = record.structured_json or {}
                        obj_name = structured.get("object", record.object_name)
                        obj_name_clean = obj_name.lower().replace("_", " ").replace("__c", "").strip()
                        obj_name_map[obj_name] = obj_name_clean

                    target_clean = target_obj.rstrip('s') if target_obj else ""
                    # Pass 1: exact match
                    exact_matches = [n for n, c in obj_name_map.items() if target_clean == c]
                    # Pass 2: substring match (only if no exact)
                    if not exact_matches:
                        exact_matches = [n for n, c in obj_name_map.items()
                                         if target_clean in c or c in target_obj]
                    allowed_objects = set(exact_matches) if target_obj else None
                    if target_obj:
                        print(f"[TEST-GEN] Object filter: target='{target_clean}', matched={exact_matches}")


                    # ─── Fetch REAL lookup values from the org ───
                    # Query MetadataRaw directly — MetadataNormalized may not have all objects
                    lookup_values = {}
                    SKIP_FIELD_NAMES = {
                        'createdbyid', 'lastmodifiedbyid', 'ownerid',
                        'recordtypeid', 'parentid',
                    }
                    try:
                        from app.models.metadata_raw import MetadataRaw
                        from app.services.salesforce_mcp_service import SalesforceMCPService
                        from app.services.integration_service import IntegrationService
                        from app.models.project_integration import ProjectIntegration

                        # Get all field metadata for this project
                        raw_result = await db.execute(
                            select(MetadataRaw).where(
                                MetadataRaw.project_id == UUID(project_id),
                                MetadataRaw.metadata_type == "field",
                            )
                        )
                        raw_fields = raw_result.scalars().all()

                        # Find reference fields and their targets
                        ref_fields = []
                        for rf in raw_fields:
                            raw = rf.raw_json or {}
                            ftype = (raw.get("type") or "").lower()
                            fname = (raw.get("name") or "").lower()
                            if ftype == "reference" and fname not in SKIP_FIELD_NAMES:
                                ref_to = raw.get("referenceTo", [])
                                label = raw.get("label", raw.get("name", ""))
                                if ref_to and label:
                                    ref_fields.append({
                                        "label": label,
                                        "referenceTo": ref_to[0],
                                        "api_name": rf.api_name,
                                    })

                        if ref_fields:
                            print(f"[TEST-GEN] Found {len(ref_fields)} reference fields: "
                                  f"{[(r['label'], r['referenceTo']) for r in ref_fields[:10]]}")

                            # Get Salesforce credentials
                            int_result = await db.execute(
                                select(ProjectIntegration).where(
                                    ProjectIntegration.project_id == UUID(project_id)
                                )
                            )
                            int_record = int_result.scalars().first()
                            if int_record and int_record.category == "salesforce":
                                decrypted = await IntegrationService.get_decrypted_tokens(int_record)
                                username = decrypted.get("username")
                                password = decrypted.get("password")
                                security_token = decrypted.get("security_token")
                                domain = "test" if (int_record.salesforce_login_url or "").find("test.salesforce.com") >= 0 else "login"

                                if username and password and security_token:
                                    queried_objects = {}
                                    
                                    # ─── Query lookup filter criteria from Tooling API ───
                                    lookup_filters = {}
                                    primary_object = exact_matches[0] if exact_matches else None
                                    print(f"[TEST-GEN] 🔍 primary_object for filters: {primary_object}")
                                    if primary_object:
                                        try:
                                            lookup_filters = SalesforceMCPService.get_lookup_filters(
                                                username=username, password=password,
                                                security_token=security_token,
                                                object_name=primary_object,
                                                domain=domain,
                                            )
                                            if lookup_filters:
                                                print(f"[TEST-GEN] 🔍 Lookup filters found: {lookup_filters}")
                                            else:
                                                print(f"[TEST-GEN] ⚠ No lookup filters returned for {primary_object}")
                                        except Exception as lf_err:
                                            print(f"[TEST-GEN] ⚠ Could not query lookup filters: {lf_err}")
                                            import traceback
                                            traceback.print_exc()
                                    
                                    for rf in ref_fields:
                                        ref_obj = rf["referenceTo"]
                                        field_api = rf.get("api_name", "")
                                        
                                        # Check if this field has a lookup filter
                                        filter_where = lookup_filters.get(field_api, "")
                                        
                                        # Use filter-specific cache key to avoid mixing filtered/unfiltered results
                                        cache_key = f"{ref_obj}|{filter_where}" if filter_where else ref_obj
                                        
                                        if cache_key in queried_objects:
                                            if queried_objects[cache_key]:
                                                lookup_values[rf["label"]] = queried_objects[cache_key]
                                            continue
                                        try:
                                            NAME_FIELD_MAP = {
                                                "Order": "OrderNumber",
                                                "Case": "CaseNumber",
                                                "Solution": "SolutionName",
                                                "Task": "Subject",
                                                "Event": "Subject",
                                                "ContentDocument": "Title",
                                            }
                                            name_field = NAME_FIELD_MAP.get(ref_obj, "Name")
                                            
                                            # Apply lookup filter criteria if available
                                            if filter_where:
                                                soql = f"SELECT Id, {name_field} FROM {ref_obj} WHERE ({filter_where}) AND {name_field} != null LIMIT 5"
                                                print(f"[TEST-GEN] Filtered SOQL for '{rf['label']}': {soql}")
                                            else:
                                                soql = f"SELECT Id, {name_field} FROM {ref_obj} WHERE {name_field} != null LIMIT 5"
                                            
                                            result = SalesforceMCPService.query(
                                                username=username, password=password,
                                                security_token=security_token,
                                                domain=domain, soql=soql,
                                            )
                                            records = result.get("records", []) if isinstance(result, dict) else []
                                            names = [r.get(name_field, "") for r in records if r.get(name_field)]
                                            queried_objects[cache_key] = names
                                            if names:
                                                lookup_values[rf["label"]] = names
                                                print(f"[TEST-GEN] Lookup '{rf['label']}' → {ref_obj}: {names}")
                                        except Exception as qe:
                                            print(f"[TEST-GEN] ⚠ Query {ref_obj} for '{rf['label']}': {qe}")
                                            queried_objects[cache_key] = []

                        if lookup_values:
                            print(f"[TEST-GEN] 🔍 All lookup values: {list(lookup_values.keys())}")
                    except Exception as lv_err:
                        print(f"[TEST-GEN] ⚠ Could not fetch lookup values: {lv_err}")

                    # Add LOOKUP VALUE RULES if we have real values
                    if lookup_values:
                        field_summary_lines.append("=== LOOKUP VALUE RULES (CRITICAL) ===")
                        field_summary_lines.append(
                            "For LOOKUP/REFERENCE fields, you MUST use one of the ValidRecords "
                            "listed below. NEVER invent a lookup value. These are REAL records from the org."
                        )
                        for field_label, record_names in lookup_values.items():
                            field_summary_lines.append(
                                f"  Field=\"{field_label}\" → ValidRecords={record_names}"
                            )
                        field_summary_lines.append("=== END LOOKUP VALUE RULES ===")
                        field_summary_lines.append("")

                    # Now build per-object field details
                    for record in meta_records:
                        structured = record.structured_json or {}
                        obj_name = structured.get("object", record.object_name)
                        if allowed_objects is not None and obj_name not in allowed_objects:
                            continue

                        fields = structured.get("fields", [])
                        if not fields:
                            continue

                        # Filter out non-createable fields (formula, auto-number,
                        # system audit fields like CreatedById, LastModifiedDate)
                        # to reduce prompt noise and prevent LLM confusion
                        fields = [f for f in fields if f.get("createable", True)]
                        if not fields:
                            continue

                        field_summary_lines.append(f"--- Object: {obj_name} (Label: {structured.get('label', obj_name)}) ---")
                        field_summary_lines.append("")


                        required_fields = [f for f in fields if f.get("required")]
                        optional_fields = [f for f in fields if not f.get("required")]

                        # Check which fields the user mentioned in their prompt
                        prompt_lower = prompt.lower()
                        user_mentioned_fields = []
                        for f in fields:
                            flabel = f.get("label", "").lower()
                            if flabel and len(flabel) > 2:
                                # Check if user prompt contains this field label
                                if flabel in prompt_lower:
                                    user_mentioned_fields.append(f.get("label", ""))

                        if user_mentioned_fields:
                            field_summary_lines.append(f"USER MENTIONED FIELDS (MUST include steps for these): {', '.join(user_mentioned_fields)}")
                            field_summary_lines.append("")

                        if required_fields:
                            field_summary_lines.append("REQUIRED FIELDS (you MUST generate a step for each):")
                            for f in required_fields:
                                raw_label = f.get("label", f.get("api", ""))
                                # Transform reference field labels to UI format
                                label = f.get("ui_label", raw_label)
                                if label == raw_label and f.get("type") == "reference" and label.endswith(" ID"):
                                    label = label[:-3] + " Name"
                                api = f.get("api", "")
                                ftype = f.get("type", "string")
                                is_user_mentioned = label.lower() in prompt_lower or raw_label.lower() in prompt_lower
                                tag = "[REQUIRED+USER-MENTIONED]" if is_user_mentioned else "[REQUIRED]"
                                # Add dependency annotation if this is a dependent picklist
                                dep_controller = f.get("controllerName", "")
                                dep_tag = f" [DEPENDENT on: {dep_controller}]" if dep_controller else ""
                                line = f"  {tag}{dep_tag} Label=\"{label}\" | API={api} | Type={ftype}"

                                # Add action hint
                                if ftype in ("picklist", "multipicklist", "combobox"):
                                    values = [pv.get("label", pv.get("value", "")) for pv in f.get("picklistValues", []) if pv.get("active")]
                                    line += f" | Action=SELECT | Values={values[:10]}"
                                elif ftype == "reference":
                                    refs = f.get("referenceTo", [])
                                    valid_recs = lookup_values.get(label, []) or lookup_values.get(raw_label, [])
                                    filtered_info = f.get("filteredLookupInfo")
                                    if filtered_info:
                                        line += f" | Action=LOOKUP_SELECT [FILTERED LOOKUP] | ReferenceTo={refs}"
                                        if valid_recs:
                                            line += (f" | ValidRecords={valid_recs}"
                                                     f" ⚠ HAS LOOKUP FILTER — ValidRecords may NOT be selectable."
                                                     f" The lookup will auto-select a valid filtered record at runtime.")
                                    else:
                                        line += f" | Action=LOOKUP_SELECT | ReferenceTo={refs}"
                                        if valid_recs:
                                            line += f" | ValidRecords={valid_recs}"
                                elif ftype in ("date", "datetime"):
                                    line += f" | Action=TYPE | Format=MM/DD/YYYY"
                                elif ftype == "boolean":
                                    line += f" | Action=CLICK"
                                else:
                                    line += f" | Action=TYPE"

                                field_summary_lines.append(line)

                        # Recommended fields: fields that are nillable=true (so not
                        # "required" by API) but are commonly required on the
                        # Salesforce page layout.  Two categories:
                        # 1) Lookup/reference fields (e.g., Account Name on Contact)
                        # 2) Email-type fields (almost always required on layouts)
                        EXCLUDE_API_PATTERNS = (
                            "ownerid", "createdbyid", "lastmodifiedbyid",
                            "masterrecordid", "individualid",
                        )
                        recommended_lookup_fields = [
                            f for f in optional_fields
                            if f.get("type") == "reference"
                            and f.get("createable", True)
                            and f.get("referenceTo")
                            and f.get("api", "").lower() not in EXCLUDE_API_PATTERNS
                        ]
                        recommended_email_fields = [
                            f for f in optional_fields
                            if f.get("type") == "email"
                            and f.get("createable", True)
                        ]
                        recommended_fields = recommended_lookup_fields + recommended_email_fields
                        print(f"[TEST-GEN] RECOMMENDED fields for {obj_name}: "
                              f"{[(f.get('label'), f.get('type')) for f in recommended_fields]}")

                        if recommended_fields:
                            field_summary_lines.append("")
                            field_summary_lines.append(
                                "RECOMMENDED FIELDS (you MUST include these in CREATE steps — "
                                "they are required on the Salesforce page layout):"
                            )
                            for f in recommended_fields[:6]:  # Limit to top 6
                                raw_label = f.get("label", f.get("api", ""))
                                ftype = f.get("type", "string")

                                if ftype == "reference":
                                    # Transform reference label: " ID" → " Name"
                                    label = f.get("ui_label", raw_label)
                                    if label == raw_label and label.endswith(" ID"):
                                        label = label[:-3] + " Name"
                                    refs = f.get("referenceTo", [])
                                    valid_recs = lookup_values.get(label, [])
                                    if not valid_recs:
                                        valid_recs = lookup_values.get(raw_label, [])
                                    if not valid_recs and refs:
                                        for lk_label, lk_vals in lookup_values.items():
                                            if refs[0].lower() in lk_label.lower():
                                                valid_recs = lk_vals
                                                break
                                    line = f"  [RECOMMENDED] Label=\"{label}\" | Type={ftype}"
                                    line += f" | Action=LOOKUP_SELECT | ReferenceTo={refs}"
                                    if valid_recs:
                                        line += f" | ValidRecords={valid_recs}"
                                elif ftype == "email":
                                    label = raw_label
                                    line = f"  [RECOMMENDED] Label=\"{label}\" | Type={ftype} | Action=TYPE"
                                else:
                                    label = raw_label
                                    line = f"  [RECOMMENDED] Label=\"{label}\" | Type={ftype} | Action=TYPE"

                                field_summary_lines.append(line)

                        if optional_fields:
                            # Separate user-mentioned fields (MUST include) from truly optional
                            user_mentioned_optional = []
                            truly_optional = []
                            for f in optional_fields:
                                label = f.get("label", f.get("api", ""))
                                if label.lower() in prompt_lower:
                                    user_mentioned_optional.append(f)
                                else:
                                    truly_optional.append(f)

                            if user_mentioned_optional:
                                field_summary_lines.append("")
                                field_summary_lines.append("USER-MENTIONED FIELDS (MANDATORY — you MUST generate a step for each):")
                                for f in user_mentioned_optional:
                                    label = f.get("label", f.get("api", ""))
                                    ftype = f.get("type", "string")
                                    line = f"  [MUST INCLUDE] Label=\"{label}\" | Type={ftype}"
                                    # Add dependency annotation
                                    dep_controller = f.get("controllerName", "")
                                    if dep_controller:
                                        line = f"  [MUST INCLUDE] [DEPENDENT on: {dep_controller}] Label=\"{label}\" | Type={ftype}"
                                    if ftype in ("picklist", "multipicklist", "combobox"):
                                        values = [pv.get("label", pv.get("value", "")) for pv in f.get("picklistValues", []) if pv.get("active")]
                                        line += f" | Action=SELECT | Values={values[:10]}"
                                    elif ftype == "reference":
                                        refs = f.get("referenceTo", [])
                                        valid_recs = lookup_values.get(label, [])
                                        line += f" | Action=LOOKUP_SELECT | ReferenceTo={refs}"
                                        if valid_recs:
                                            line += f" | ValidRecords={valid_recs}"
                                    elif ftype in ("date", "datetime"):
                                        line += f" | Action=TYPE | Format=MM/DD/YYYY"
                                    else:
                                        line += f" | Action=TYPE"
                                    field_summary_lines.append(line)
                                print(f"[TEST-GEN] User-mentioned optional fields: {[f.get('label') for f in user_mentioned_optional]}")

                            if truly_optional:
                                field_summary_lines.append("")
                                field_summary_lines.append(
                                    f"OTHER FIELDS ({len(truly_optional)} optional fields exist on this object. "
                                    "DO NOT generate steps for these unless the user explicitly mentions them "
                                    "in their prompt. For simple CREATE prompts, ONLY fill REQUIRED fields.):"
                                )
                                # Only list field names for reference, no action details
                                # This prevents the LLM from generating steps for them
                                opt_names = [f.get("label", "") for f in truly_optional[:20] if f.get("label")]
                                if opt_names:
                                    field_summary_lines.append(f"  Available: {', '.join(opt_names)}")

                        # ─── Add explicit DEPENDENT PICKLIST RELATIONSHIPS section ───
                        dep_relationships = []
                        for f in fields:
                            ctrl = f.get("controllerName", "")
                            if ctrl and f.get("dependentPicklist"):
                                dep_label = f.get("label", f.get("api", ""))
                                # Resolve controller API name to label
                                ctrl_label = ctrl
                                for cf in fields:
                                    if cf.get("api", "") == ctrl:
                                        ctrl_label = cf.get("label", ctrl)
                                        break
                                dep_relationships.append((ctrl_label, dep_label))

                        if dep_relationships:
                            field_summary_lines.append("")
                            field_summary_lines.append("=== DEPENDENT PICKLIST RELATIONSHIPS (CRITICAL — STEP ORDERING) ===")
                            field_summary_lines.append(
                                "The following fields are DEPENDENT PICKLISTS. "
                                "You MUST generate the controlling field's step BEFORE the dependent field's step. "
                                "If the controlling field is not selected first, the dependent field will have NO options."
                            )
                            for ctrl_label, dep_label in dep_relationships:
                                field_summary_lines.append(
                                    f"  RULE: SELECT \"{ctrl_label}\" BEFORE SELECT \"{dep_label}\""
                                )
                            field_summary_lines.append("=== END DEPENDENT PICKLIST RELATIONSHIPS ===")

                        field_summary_lines.append("")

                    field_summary = "\n".join(field_summary_lines)
                    field_summary += "\n=== END OF FIELD REFERENCE ==="
                    rag_context += field_summary
                    print(f"[TEST-GEN] Supplemented RAG with direct metadata ({len(field_summary_lines)} lines)")
                except Exception as meta_err:
                    print(f"[TEST-GEN] Failed to supplement with direct metadata: {meta_err}")

                test_case = await AIService.generate_test_case_with_mcp_rag(
                    prompt, rag_context, provider=provider, model=model
                )
                print(f"[TEST-GEN] MCP RAG generation successful with {len(retrieved_chunks)} chunks")

                # ─── Post-generation: Auto-inject + reorder steps ───
                try:
                    steps = test_case.get("steps", [])
                    step_targets = {s.get("target", "").lower() for s in steps if s.get("target")}

                    # Check which extracted field-value pairs are missing from generated steps
                    injected = []
                    for flabel, fval, faction, ftype in matched_extractions:
                        has_step = any(
                            flabel.lower() in t or t in flabel.lower()
                            for t in step_targets
                        )
                        if not has_step:
                            if faction == "LOOKUP":
                                action_name = "LOOKUP"
                            elif faction == "SELECT":
                                action_name = "SELECT"
                            else:
                                action_name = "TYPE"

                            new_step = {
                                "id": str(len(steps) + 1),
                                "action": action_name,
                                "target": flabel,
                                "value": fval,
                                "locator_type": "label",
                            }
                            injected.append((flabel, new_step))

                    if injected:
                        save_idx = None
                        for i, s in enumerate(steps):
                            t = (s.get("target") or "").lower()
                            if s.get("action", "").lower() == "click" and "save" in t:
                                save_idx = i
                                break

                        for flabel, new_step in reversed(injected):
                            if save_idx is not None:
                                steps.insert(save_idx, new_step)
                            else:
                                steps.append(new_step)

                        injected_names = [f[0] for f in injected]
                        print(f"[TEST-GEN] ✅ Auto-injected missing user-mentioned steps: {injected_names}")

                    # ─── Validate ALL required metadata fields have steps ───
                    # This catches required fields the LLM missed even though
                    # they were in the metadata (e.g. Account on Contact)
                    # BUT: Only auto-inject for CREATE/NEW operations!
                    # For VIEW/OPEN/EDIT/DELETE, we should NOT inject required fields.
                    is_create_op = any(kw in prompt_lower for kw in [
                        'create ', 'new ', 'add ', 'insert ',
                    ])
                    # Also check if the generated steps already contain a "New" click
                    has_new_click = any(
                        s.get("action", "").lower() == "click"
                        and "new" in (s.get("target") or "").lower()
                        for s in steps
                    )
                    is_create_op = is_create_op or has_new_click

                    is_view_op = any(kw in prompt_lower for kw in [
                        'open ', 'view ', 'read ', 'navigate ',
                        'generate pdf', 'generate invoice', 'preview',
                        'delete ', 'clone ', 'inline edit',
                    ])

                    if is_view_op and not is_create_op:
                        print(f"[TEST-GEN] ℹ Skipping required field injection — "
                              f"detected VIEW/OPEN operation, not CREATE")
                    else:
                        step_targets_after = {
                            s.get("target", "").lower()
                            for s in steps
                            if s.get("target") and s.get("action", "").upper() in (
                                "TYPE", "SELECT", "LOOKUP", "LOOKUP_SELECT",
                                "CHECKBOX", "MULTI_SELECT", "FILL", "INPUT",
                            )
                        }
                        required_injected = []
                        for record in meta_records:
                            structured_r = record.structured_json or {}
                            obj_r = structured_r.get("object", record.object_name)
                            if allowed_objects is not None and obj_r not in allowed_objects:
                                continue
                            for f in structured_r.get("fields", []):
                                if not f.get("required") or not f.get("createable", True):
                                    continue
                                label = f.get("label", "")
                                if not label:
                                    continue
                                # Check if any existing step targets this field
                                has_step = any(
                                    label.lower() in t or t in label.lower()
                                    for t in step_targets_after
                                )
                                if has_step:
                                    continue
                                # Determine the correct action and a sensible default value
                                ftype = f.get("type", "string")
                                if ftype == "reference":
                                    action_name = "LOOKUP"
                                    valid_recs = lookup_values.get(label, [])
                                    default_val = valid_recs[0] if valid_recs else "Test"
                                elif ftype in ("picklist", "combobox"):
                                    action_name = "SELECT"
                                    pvals = [pv.get("label", pv.get("value", ""))
                                             for pv in f.get("picklistValues", []) if pv.get("active")]
                                    default_val = pvals[0] if pvals else "Other"
                                elif ftype == "multipicklist":
                                    action_name = "MULTI_SELECT"
                                    pvals = [pv.get("label", pv.get("value", ""))
                                             for pv in f.get("picklistValues", []) if pv.get("active")]
                                    default_val = pvals[0] if pvals else "Other"
                                elif ftype == "boolean":
                                    action_name = "CHECKBOX"
                                    default_val = "true"
                                elif ftype in ("date", "datetime"):
                                    action_name = "TYPE"
                                    default_val = "01/01/2025"
                                elif ftype == "email":
                                    action_name = "TYPE"
                                    default_val = "test@example.com"
                                elif ftype == "phone":
                                    action_name = "TYPE"
                                    default_val = "9876543210"
                                elif ftype in ("currency", "double", "int", "percent"):
                                    action_name = "TYPE"
                                    default_val = "100"
                                else:
                                    action_name = "TYPE"
                                    default_val = f"Test {label}"

                                new_step = {
                                    "id": str(len(steps) + 1),
                                    "action": action_name,
                                    "target": label,
                                    "value": default_val,
                                    "locator_type": "label",
                                }
                                required_injected.append((label, new_step))
                                step_targets_after.add(label.lower())

                        if required_injected:
                            save_idx = None
                            for i, s in enumerate(steps):
                                t = (s.get("target") or "").lower()
                                if s.get("action", "").lower() == "click" and "save" in t:
                                    save_idx = i
                                    break
                            for flabel, new_step in reversed(required_injected):
                                if save_idx is not None:
                                    steps.insert(save_idx, new_step)
                                else:
                                    steps.append(new_step)
                            req_names = [f[0] for f in required_injected]
                            print(f"[TEST-GEN] ✅ Auto-injected missing REQUIRED fields: {req_names}")

                    # ─── Defer early TYPE steps to after all LOOKUP/SELECT ───
                    # Salesforce Lightning re-renders the form during lookup/picklist
                    # interactions, which can clear previously-typed text values.
                    # Fix: move TYPE steps that appear before any LOOKUP/SELECT
                    # to right before the Save click. Keep LOOKUP/SELECT order intact.
                    new_idx = None
                    save_idx = None
                    for i, s in enumerate(steps):
                        t = (s.get("target") or "").lower()
                        act = s.get("action", "").lower()
                        if act == "click" and "new" in t and new_idx is None:
                            new_idx = i
                        if act == "click" and "save" in t:
                            save_idx = i
                            break

                    if new_idx is not None and save_idx is not None and save_idx > new_idx + 1:
                        middle = steps[new_idx + 1:save_idx]

                        # Find the index of the LAST lookup/select step in middle
                        last_ls_idx = -1
                        for mi, s in enumerate(middle):
                            act = s.get("action", "").lower()
                            if act in ("lookup", "lookup_select", "select"):
                                last_ls_idx = mi

                        # Move any TYPE steps from BEFORE last_ls_idx to AFTER it
                        if last_ls_idx > 0:
                            deferred = []
                            kept = []
                            for mi, s in enumerate(middle):
                                act = s.get("action", "").lower()
                                if mi < last_ls_idx and act in ("type", "fill", "input"):
                                    deferred.append(s)
                                else:
                                    kept.append(s)
                            if deferred:
                                # Insert deferred TYPE steps after last lookup/select
                                new_last_ls = -1
                                for ki, s in enumerate(kept):
                                    if s.get("action", "").lower() in ("lookup", "lookup_select", "select"):
                                        new_last_ls = ki
                                insert_at = new_last_ls + 1 if new_last_ls >= 0 else len(kept)
                                for ds in reversed(deferred):
                                    kept.insert(insert_at, ds)
                                steps = steps[:new_idx + 1] + kept + steps[save_idx:]
                                print(f"[TEST-GEN] ↕ Deferred {len(deferred)} TYPE steps to after LOOKUP/SELECT")

                    # Re-number all step IDs
                    for i, s in enumerate(steps):
                        s["id"] = str(i + 1)
                    test_case["steps"] = steps

                except Exception as val_err:
                    print(f"[TEST-GEN] Post-generation check error: {val_err}")

                return test_case
            else:
                print(f"[TEST-GEN] No RAG chunks found, falling back to standard with MCP instruction")
                session_instruction = (
                    "\n\nIMPORTANT: This is a Salesforce MCP-connected project. "
                    "DO NOT generate any login/authentication steps. "
                    "Use Salesforce Lightning URL patterns like /lightning/o/ObjectName/list."
                )
        except Exception as rag_err:
            print(f"[TEST-GEN] MCP RAG failed, falling back to standard: {rag_err}")

    # --- Standard path ---
    effective_prompt = prompt + session_instruction

    try:
        test_case = await AIService.generate_test_case(effective_prompt, provider=provider, model=model)
        return test_case
    except openai.RateLimitError:
        raise HTTPException(
            status_code=429, 
            detail="OpenAI API Quota Exceeded. Please check your billing details or API key credits."
        )
    except openai.APIError as e:
        raise HTTPException(status_code=502, detail=f"OpenAI API returned an error: {e.message}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal Server Error: {str(e)}")

from app.models.project import Project

@router.post("/", response_model=TestCaseResponse)
async def create_test(test: TestCaseCreate, db: AsyncSession = Depends(get_db)):
    new_test = TestCase(
        name=test.name,
        description=test.description,
        project_id=test.project_id,
        steps=[step.dict() for step in test.steps],
        priority=test.priority
    )
    
    db.add(new_test)
    await db.commit()
    await db.refresh(new_test)
    
    # Load project name
    result = await db.execute(select(Project.name).where(Project.id == new_test.project_id))
    new_test.project_name = result.scalar_one_or_none()
    
    return new_test

@router.get("/", response_model=List[TestCaseResponse])
async def list_tests(skip: int = 0, limit: int = 100, db: AsyncSession = Depends(get_db)):
    query = select(TestCase, Project.name.label("project_name")).join(Project, TestCase.project_id == Project.id).offset(skip).limit(limit)
    result = await db.execute(query)
    tests_with_projects = result.all()
    
    response = []
    for test, project_name in tests_with_projects:
        test.project_name = project_name
        response.append(test)
    return response

@router.get("/{id}", response_model=TestCaseResponse)
async def get_test(id: UUID, db: AsyncSession = Depends(get_db)):
    query = select(TestCase, Project.name.label("project_name")).join(Project, TestCase.project_id == Project.id).where(TestCase.id == id)
    result = await db.execute(query)
    test_data = result.first()
    
    if not test_data:
        raise HTTPException(status_code=404, detail="Test case not found")
    
    test, project_name = test_data
    test.project_name = project_name
    return test

@router.put("/{id}", response_model=TestCaseResponse)
async def update_test(id: UUID, test_update: TestCaseCreate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TestCase).where(TestCase.id == id))
    test = result.scalars().first()
    if not test:
        raise HTTPException(status_code=404, detail="Test case not found")
    
    test.name = test_update.name
    test.description = test_update.description
    test.project_id = test_update.project_id
    test.steps = [step.dict() for step in test_update.steps]
    test.priority = test_update.priority
    
    await db.commit()
    await db.refresh(test)
    return test

@router.delete("/{id}", status_code=204)
async def delete_test(id: UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TestCase).where(TestCase.id == id))
    test = result.scalars().first()
    if not test:
        raise HTTPException(status_code=404, detail="Test case not found")
    
    await db.delete(test)
    await db.commit()
    return None
