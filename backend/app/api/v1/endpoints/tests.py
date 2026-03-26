from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import List, Dict, Any, Optional
from uuid import UUID
import openai
import os

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

    provider = prompt_data.get("provider", "claude")
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

    # ──────────────────────────────────────────────────────────────────
    # WEBAPP CRAWLER PATH — only for project_category == "webapp"
    # Crawls the live app to extract real DOM metadata, then uses it
    # to ground the AI prompt in actual page elements.
    # Zero impact on Salesforce: protected by strict category check.
    # ──────────────────────────────────────────────────────────────────
    if project_id:
        try:
            from app.models.project import Project as _Project
            _pid = UUID(project_id)
            _proj_res = await db.execute(select(_Project).where(_Project.id == _pid))
            _project = _proj_res.scalars().first()

            if _project and getattr(_project, "category", "") == "webapp":
                effective_base_url = (
                    getattr(_project, "base_url", None) or ""
                ).rstrip("/")

                if effective_base_url:
                    print(
                        f"[TEST-GEN] WebApp project {_pid} | base_url={effective_base_url} "
                        f"→ triggering Playwright crawler"
                    )
                    try:
                        from app.services.web_crawler_service import WebCrawlerService
                        from app.models.metadata_normalized import MetadataNormalized
                        from datetime import datetime

                        # ── Check DB cache (entity_type='webapp_crawl') ──
                        # Reuses the existing metadata_normalized table (no new columns).
                        # Cache is keyed by project_id + object_name='webapp_crawl'.
                        cached_result = await db.execute(
                            select(MetadataNormalized).where(
                                MetadataNormalized.project_id == _pid,
                                MetadataNormalized.entity_type == "webapp_crawl",
                            )
                        )
                        cached_row = cached_result.scalars().first()

                        # Use cache if it exists and is less than 30 minutes old
                        USE_CACHE = False
                        if cached_row and cached_row.structured_json:
                            age_seconds = (
                                datetime.utcnow() - cached_row.created_at
                            ).total_seconds()
                            if age_seconds < 1800:  # 30-minute TTL
                                USE_CACHE = True
                                print(
                                    f"[TEST-GEN] Using cached webapp metadata "
                                    f"({int(age_seconds)}s old)"
                                )

                        if USE_CACHE:
                            webapp_meta = WebCrawlerService.from_structured_json(
                                cached_row.structured_json
                            )
                        else:
                            # ── Resolve auth session path ──
                            # Reuses storageState files saved by WebPlaywrightService.
                            from app.services.playwright_core_service import SESSIONS_DIR
                            session_path = os.path.join(
                                SESSIONS_DIR, f"{project_id}_web.json"
                            )
                            auth_path = (
                                session_path if os.path.exists(session_path) else None
                            )

                            # ── Run the crawler ──
                            webapp_meta = await WebCrawlerService.crawl(
                                base_url=effective_base_url,
                                max_pages=8,
                                auth_session_path=auth_path,
                            )

                            # ── Persist to DB cache (upsert) ──
                            structured = WebCrawlerService.to_structured_json(webapp_meta)
                            if cached_row:
                                cached_row.structured_json = structured
                                cached_row.created_at = datetime.utcnow()
                            else:
                                new_row = MetadataNormalized(
                                    project_id=_pid,
                                    object_name="webapp_crawl",
                                    entity_type="webapp_crawl",
                                    label=effective_base_url,
                                    structured_json=structured,
                                )
                                db.add(new_row)
                            await db.commit()
                            print(
                                f"[TEST-GEN] Crawl complete: {len(webapp_meta.pages)} pages cached"
                            )

                            # ── Generate vector embeddings from crawled pages ──
                            # Per-page chunking → OpenAI embeddings → vector_embeddings table
                            try:
                                from app.services.embedding_service import EmbeddingService
                                embed_count = await EmbeddingService.generate_embeddings(db, _pid)
                                print(f"[TEST-GEN] Generated {embed_count} webapp vector embeddings")
                            except Exception as embed_err:
                                print(f"[TEST-GEN] Embedding generation (non-critical): {embed_err}")

                        # ── Build context string + generate ──
                        if webapp_meta.pages:
                            # ── Targeted deep crawl for creation forms ──
                            # If the prompt mentions creating/adding a record,
                            # navigate INTO the form to extract mandatory fields
                            import re as _re

                            # Extract object name from prompts like:
                            # "create new contact record", "add a new account",
                            # "create contact", "new lead record"
                            # "opportunity record creation", "create record for opportunity"
                            _target_object = None
                            _prompt_lower = prompt.lower()
                            _create_match = _re.search(
                                r'\b(?:create|add)\b\s+(?:a\s+)?(?:new\s+)?(\w+)(?:\s+(\w+))?',
                                _prompt_lower
                            )
                            if not _create_match:
                                # Pattern: "new contact record", "new opportunity"
                                _create_match = _re.search(
                                    r'\bnew\s+(\w+)(?:\s+(\w+))?',
                                    _prompt_lower
                                )

                            # Skip generic/filler words
                            _skip_words = {
                                "record", "entry", "form", "item", "test", "case",
                                "step", "the", "a", "an", "new", "with", "for",
                            }

                            if _create_match:
                                _word1 = _create_match.group(1).strip()
                                _word2 = (_create_match.group(2) or "").strip()
                                # If first word is a filler (e.g. "create record opportunity"),
                                # use the second word
                                if _word1 in _skip_words and _word2 and _word2 not in _skip_words:
                                    _target_object = _word2
                                elif _word1 not in _skip_words:
                                    _target_object = _word1
                                # Also try scanning for known CRM objects in the prompt
                                if not _target_object:
                                    _known_objects = [
                                        "opportunity", "contact", "account", "lead",
                                        "campaign", "case", "report",
                                    ]
                                    for obj in _known_objects:
                                        if obj in _prompt_lower:
                                            _target_object = obj
                                            break

                            if _target_object and _target_object not in _skip_words:
                                    print(f"[TEST-GEN] Detected creation intent for object: '{_target_object}'")
                                    try:
                                        from app.services.playwright_core_service import SESSIONS_DIR
                                        from app.services.integration_service import IntegrationService
                                        _session_path = os.path.join(
                                            SESSIONS_DIR, f"{project_id}_web.json"
                                        )
                                        _auth = _session_path if os.path.exists(_session_path) else _session_path

                                        # Decrypt credentials for auto-login
                                        _creds = None
                                        try:
                                            _int_result = await db.execute(
                                                select(MetadataNormalized).where(
                                                    MetadataNormalized.project_id == _pid,
                                                ).limit(1)
                                            )
                                            from app.models.project_integration import ProjectIntegration
                                            _int_res = await db.execute(
                                                select(ProjectIntegration).where(
                                                    ProjectIntegration.project_id == _pid,
                                                )
                                            )
                                            _int_rec = _int_res.scalars().first()
                                            if _int_rec:
                                                _dec = await IntegrationService.get_decrypted_tokens(_int_rec)
                                                if _dec.get("username") and _dec.get("password"):
                                                    _creds = {
                                                        "username": _dec["username"],
                                                        "password": _dec["password"],
                                                    }
                                        except Exception as cred_err:
                                            print(f"[TEST-GEN] Credential fetch (non-critical): {cred_err}")

                                        _form_page = await WebCrawlerService.crawl_creation_form(
                                            base_url=effective_base_url,
                                            object_name=_target_object,
                                            auth_session_path=_auth,
                                            credentials=_creds,
                                        )
                                        if _form_page and (_form_page.inputs or _form_page.buttons):
                                            # Merge form page into webapp_meta
                                            webapp_meta.pages.append(_form_page)
                                            print(
                                                f"[TEST-GEN] Deep crawl: added form page with "
                                                f"{len(_form_page.inputs)} inputs, "
                                                f"{len(_form_page.buttons)} buttons, "
                                                f"{len([i for i in _form_page.inputs if i.required])} required"
                                            )
                                        else:
                                            print("[TEST-GEN] Deep crawl: no form fields found")
                                    except Exception as deep_err:
                                        print(f"[TEST-GEN] Deep crawl (non-critical): {deep_err}")

                            webapp_context = WebCrawlerService.build_context_string(
                                webapp_meta
                            )

                            # ── Enrich with RAG context (execution learnings) ──
                            # Retrieve relevant past test execution patterns via vector similarity
                            try:
                                from app.services.rag_service import RAGService
                                rag_chunks = await RAGService.retrieve(
                                    db, _pid, prompt, top_k=5
                                )
                                if rag_chunks:
                                    rag_context = await RAGService.build_rag_context(
                                        rag_chunks, categorize=True
                                    )
                                    webapp_context = webapp_context + "\n\n" + rag_context
                                    print(f"[TEST-GEN] Enriched with {len(rag_chunks)} RAG chunks")
                            except Exception as rag_err:
                                print(f"[TEST-GEN] RAG enrichment (non-critical): {rag_err}")

                            print(
                                f"[TEST-GEN] Generating with webapp metadata "
                                f"({len(webapp_meta.pages)} pages, "
                                f"context_len={len(webapp_context)})"
                            )
                            test_case = await AIService.generate_test_case_with_webapp_metadata(
                                prompt, webapp_context, provider=provider, model=model
                            )
                            return test_case
                        else:
                            print(
                                "[TEST-GEN] Crawler returned 0 pages, "
                                "falling back to standard generation"
                            )

                    except Exception as crawl_err:
                        print(
                            f"[TEST-GEN] WebApp crawler failed: {crawl_err} "
                            f"— falling back to standard generation"
                        )
        except Exception as _e:
            print(f"[TEST-GEN] WebApp path detection error: {_e}")

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
                # Try to extract the object name from common prompt patterns
                obj_match = _re.search(
                    r'(?:create|new|edit|update|delete|view|test)\s+(?:(?:a|an|the)\s+)?(?:new\s+)?'
                    r'(\w[\w\s]*?)(?:\s+record|\s+for|\s+with|\s+-|\s*$)',
                    prompt_lower
                )
                target_obj = obj_match.group(1).strip() if obj_match else None
                print(f"[TEST-GEN] Detected target object: '{target_obj}'")

                if target_obj:
                    # Filter chunks that mention the target object
                    filtered = [c for c in retrieved_chunks if target_obj in c.lower()]
                    if filtered:
                        print(f"[TEST-GEN] Filtered {len(retrieved_chunks)} chunks → {len(filtered)} chunks for object '{target_obj}'")
                        retrieved_chunks = filtered
                    else:
                        print(f"[TEST-GEN] No chunks matched '{target_obj}', using all {len(retrieved_chunks)} chunks")

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
                        "CRITICAL — You MUST generate a step for:",
                        "  1. EVERY field listed in EXTRACTED FIELDS below",
                        "  2. EVERY field marked [REQUIRED] below",
                        "  3. EVERY field the user explicitly mentions in their prompt",
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

                    for record in meta_records:
                        structured = record.structured_json or {}
                        obj_name = structured.get("object", record.object_name)

                        # Only include allowed objects
                        if allowed_objects is not None and obj_name not in allowed_objects:
                            continue
                        print(f"[TEST-GEN] Including metadata for object: {obj_name} (fields: {len(structured.get('fields', []))})")


                        fields = structured.get("fields", [])
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
                                label = f.get("label", f.get("api", ""))
                                api = f.get("api", "")
                                ftype = f.get("type", "string")
                                is_user_mentioned = label.lower() in prompt_lower
                                tag = "[REQUIRED+USER-MENTIONED]" if is_user_mentioned else "[REQUIRED]"
                                line = f"  {tag} Label=\"{label}\" | API={api} | Type={ftype}"

                                # Add action hint
                                if ftype in ("picklist", "multipicklist", "combobox"):
                                    values = [pv.get("label", pv.get("value", "")) for pv in f.get("picklistValues", []) if pv.get("active")]
                                    line += f" | Action=SELECT | Values={values[:10]}"
                                elif ftype == "reference":
                                    refs = f.get("referenceTo", [])
                                    line += f" | Action=LOOKUP_SELECT | ReferenceTo={refs}"
                                elif ftype in ("date", "datetime"):
                                    line += f" | Action=TYPE | Format=MM/DD/YYYY"
                                elif ftype == "boolean":
                                    line += f" | Action=CLICK"
                                else:
                                    line += f" | Action=TYPE"

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
                                    if ftype in ("picklist", "multipicklist", "combobox"):
                                        values = [pv.get("label", pv.get("value", "")) for pv in f.get("picklistValues", []) if pv.get("active")]
                                        line += f" | Action=SELECT | Values={values[:10]}"
                                    elif ftype == "reference":
                                        refs = f.get("referenceTo", [])
                                        line += f" | Action=LOOKUP_SELECT | ReferenceTo={refs}"
                                    elif ftype in ("date", "datetime"):
                                        line += f" | Action=TYPE | Format=MM/DD/YYYY"
                                    else:
                                        line += f" | Action=TYPE"
                                    field_summary_lines.append(line)
                                print(f"[TEST-GEN] User-mentioned optional fields: {[f.get('label') for f in user_mentioned_optional]}")

                            if truly_optional:
                                field_summary_lines.append("")
                                field_summary_lines.append("OTHER FIELDS (generate steps if user mentions them):")
                                for f in truly_optional[:40]:  # Limit to avoid token overflow
                                    label = f.get("label", f.get("api", ""))
                                    ftype = f.get("type", "string")
                                    line = f"  [OPTIONAL] Label=\"{label}\" | Type={ftype}"
                                    if ftype in ("picklist", "multipicklist", "combobox"):
                                        values = [pv.get("label", pv.get("value", "")) for pv in f.get("picklistValues", []) if pv.get("active")]
                                        line += f" | Action=SELECT | Values={values[:10]}"
                                    elif ftype == "reference":
                                        line += f" | Action=LOOKUP_SELECT"
                                    elif ftype in ("date", "datetime"):
                                        line += f" | Action=TYPE | Format=MM/DD/YYYY"
                                    else:
                                        line += f" | Action=TYPE"
                                    field_summary_lines.append(line)

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
                        print(f"[TEST-GEN] ✅ Auto-injected missing steps: {injected_names}")

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

    # --- Standard path (with automatic OpenAI → Claude fallback) ---
    effective_prompt = prompt + session_instruction

    try:
        test_case = await AIService.generate_test_case(effective_prompt, provider=provider, model=model)
        return test_case
    except (openai.AuthenticationError, openai.APIConnectionError, openai.APIError) as openai_err:
        # If OpenAI fails, automatically fall back to Claude
        print(f"[TEST-GEN] OpenAI failed ({type(openai_err).__name__}: {openai_err}), falling back to Claude...")
        try:
            test_case = await AIService.generate_test_case(effective_prompt, provider="claude", model=None)
            print(f"[TEST-GEN] ✅ Claude fallback succeeded")
            return test_case
        except Exception as claude_err:
            print(f"[TEST-GEN] Claude fallback also failed: {claude_err}")
            # Report the original OpenAI error + fallback failure
            detail = f"OpenAI API error: {getattr(openai_err, 'message', str(openai_err))}. Claude fallback also failed: {str(claude_err)}"
            raise HTTPException(status_code=502, detail=detail)
    except openai.RateLimitError:
        raise HTTPException(
            status_code=429, 
            detail="OpenAI API Quota Exceeded. Please check your billing details or API key credits."
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal Server Error: {str(e)}")

from pydantic import BaseModel

class HumanizeStepsRequest(BaseModel):
    steps: list
    provider: str = "claude"

@router.post("/humanize-steps", response_model=Dict[str, Any])
async def humanize_steps_endpoint(
    payload: HumanizeStepsRequest,
):
    """Convert technical test steps into human-readable natural language."""
    if not payload.steps:
        raise HTTPException(status_code=400, detail="A non-empty 'steps' array is required")

    try:
        result = await AIService.humanize_steps(payload.steps, provider=payload.provider)
        return result
    except Exception as e:
        print(f"[HUMANIZE] Error: {type(e).__name__}: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to humanize steps: {str(e)}")

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
