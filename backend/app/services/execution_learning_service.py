"""
Execution Learning Service
Processes test execution results to generate structured learning records
that are embedded and stored in the vector database for future RAG retrieval.
"""
from typing import List, Dict, Any, Optional
from uuid import UUID
import json
import logging
import re

from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from app.core.config import settings
from app.models.execution_learning import ExecutionLearning
from app.models.vector_embedding import VectorEmbedding
from app.models.test_case import TestCase
from app.models.test_run import TestRun

logger = logging.getLogger(__name__)

EMBEDDING_MODEL = "text-embedding-3-small"

# Known field type → correct action mappings
FIELD_TYPE_ACTION_MAP = {
    "string": "TYPE",
    "textarea": "TYPE",
    "email": "TYPE",
    "phone": "TYPE",
    "url": "TYPE",
    "currency": "TYPE",
    "int": "TYPE",
    "double": "TYPE",
    "percent": "TYPE",
    "date": "TYPE",
    "datetime": "TYPE",
    "picklist": "SELECT",
    "multipicklist": "SELECT",
    "combobox": "SELECT",
    "reference": "LOOKUP_SELECT",
    "lookup": "LOOKUP_SELECT",
    "boolean": "CLICK",
}


class ExecutionLearningService:
    """
    Processes test execution results to create learning records that
    improve future test step generation via RAG retrieval.
    """

    @staticmethod
    async def process_execution_result(
        db: AsyncSession,
        test_run_id: UUID,
        result_data: Dict[str, Any],
    ) -> None:
        """
        Entry point called after each test execution.
        Dispatches to success or failure learning handlers.
        """
        try:
            # Fetch the test run and associated test case
            run_result = await db.execute(
                select(TestRun).where(TestRun.id == test_run_id)
            )
            test_run = run_result.scalars().first()
            if not test_run:
                logger.warning(f"[LEARNING] Test run {test_run_id} not found")
                return

            tc_result = await db.execute(
                select(TestCase).where(TestCase.id == test_run.test_case_id)
            )
            test_case = tc_result.scalars().first()
            if not test_case:
                logger.warning(f"[LEARNING] Test case for run {test_run_id} not found")
                return

            if not test_case.project_id:
                logger.warning(f"[LEARNING] Test case has no project_id, skipping")
                return

            status = result_data.get("status", "").lower()

            if status == "passed":
                await ExecutionLearningService._store_success_learning(
                    db, test_run, test_case, result_data
                )
            elif status in ("failed", "error"):
                await ExecutionLearningService._store_failure_learning(
                    db, test_run, test_case, result_data
                )

            logger.info(f"[LEARNING] Processed execution result for run {test_run_id} (status={status})")

        except Exception as e:
            logger.error(f"[LEARNING] Failed to process execution result: {e}")

    @staticmethod
    async def _store_success_learning(
        db: AsyncSession,
        test_run: TestRun,
        test_case: TestCase,
        result_data: Dict[str, Any],
    ) -> None:
        """
        Store a successful execution pattern for future retrieval.
        Creates a learning record and embeds it into the vector store.
        """
        steps = test_case.steps or []
        if not steps:
            return

        # Extract object name from steps (look for NAVIGATE to /lightning/o/{Object}/...)
        object_name = ExecutionLearningService._extract_object_name(steps)

        # Build description of the test scenario
        test_desc = test_case.description or test_case.name or "Test case"

        # Create learning record
        learning = ExecutionLearning(
            project_id=test_case.project_id,
            test_case_id=test_case.id,
            test_run_id=test_run.id,
            learning_type="success_pattern",
            object_name=object_name,
            steps_pattern=steps,
            extra_metadata={
                "test_name": test_case.name,
                "description": test_desc,
                "duration": result_data.get("duration"),
                "step_count": len(steps),
            },
        )
        db.add(learning)
        await db.flush()

        # Generate text chunk for embedding
        text = ExecutionLearningService._create_success_text(
            object_name, test_desc, steps
        )

        await ExecutionLearningService._embed_and_store(
            db, test_case.project_id, learning.id, "success_pattern", text
        )

        # Also store field behavior mappings from successful steps
        await ExecutionLearningService._store_field_behaviors(
            db, test_case.project_id, learning.id, steps, object_name
        )

        await db.commit()
        logger.info(
            f"[LEARNING] Stored success pattern for '{test_case.name}' "
            f"(object={object_name}, steps={len(steps)})"
        )

    @staticmethod
    async def _store_failure_learning(
        db: AsyncSession,
        test_run: TestRun,
        test_case: TestCase,
        result_data: Dict[str, Any],
    ) -> None:
        """
        Analyze a failed execution and store failure correction patterns.
        Detects field-action mismatches from error logs.
        """
        steps = test_case.steps or []
        logs = result_data.get("logs", [])
        object_name = ExecutionLearningService._extract_object_name(steps)

        # Parse failed step logs to find specific failures
        failed_steps = []
        if isinstance(logs, list):
            for log_entry in logs:
                if isinstance(log_entry, dict) and log_entry.get("status") in ("failed", "error"):
                    failed_steps.append(log_entry)

        if not failed_steps:
            # Store a general failure record even without step details
            learning = ExecutionLearning(
                project_id=test_case.project_id,
                test_case_id=test_case.id,
                test_run_id=test_run.id,
                learning_type="failure_correction",
                object_name=object_name,
                failure_reason=result_data.get("error", "Unknown failure"),
                steps_pattern=steps,
                extra_metadata={
                    "test_name": test_case.name,
                    "overall_error": str(result_data.get("error", "")),
                },
            )
            db.add(learning)
            await db.flush()

            text = ExecutionLearningService._create_failure_text(
                object_name, test_case.name, None, None, None,
                result_data.get("error", "Unknown failure"), steps
            )
            await ExecutionLearningService._embed_and_store(
                db, test_case.project_id, learning.id, "failure_correction", text
            )
            await db.commit()
            return

        # Process each failed step
        for failed_log in failed_steps:
            error_msg = failed_log.get("error", "")
            step_order = failed_log.get("step_order", 0)
            action = failed_log.get("action", "")

            # Try to identify the field and detect action mismatch
            field_name = None
            field_type = None
            correct_action = None

            # Find the corresponding step in the test case
            if step_order and isinstance(step_order, int) and step_order <= len(steps):
                failed_step = steps[step_order - 1] if step_order > 0 else None
                if failed_step:
                    field_name = failed_step.get("target", "")
                    action = failed_step.get("action", action)

                    # Detect common mismatches from error messages
                    correct_action = ExecutionLearningService._detect_correct_action(
                        error_msg, action, field_name
                    )

            learning = ExecutionLearning(
                project_id=test_case.project_id,
                test_case_id=test_case.id,
                test_run_id=test_run.id,
                learning_type="failure_correction",
                object_name=object_name,
                field_name=field_name,
                field_type=field_type,
                action_attempted=action,
                correct_action=correct_action,
                failure_reason=error_msg,
                extra_metadata={
                    "test_name": test_case.name,
                    "step_order": step_order,
                },
            )
            db.add(learning)
            await db.flush()

            text = ExecutionLearningService._create_failure_text(
                object_name, test_case.name, field_name, action,
                correct_action, error_msg, steps
            )
            await ExecutionLearningService._embed_and_store(
                db, test_case.project_id, learning.id, "failure_correction", text
            )

        await db.commit()
        logger.info(
            f"[LEARNING] Stored {len(failed_steps)} failure corrections for '{test_case.name}'"
        )

    @staticmethod
    async def _store_field_behaviors(
        db: AsyncSession,
        project_id: UUID,
        source_id: UUID,
        steps: List[Dict[str, Any]],
        object_name: Optional[str],
    ) -> None:
        """
        Extract and store field type → action mappings from successful steps.
        """
        field_actions = []
        for step in steps:
            action = step.get("action", "").upper()
            target = step.get("target", "")
            locator_type = step.get("locator_type", "")

            # Only learn from field-level interactions (label-based locators)
            if locator_type == "label" and target and action in (
                "TYPE", "SELECT", "LOOKUP", "LOOKUP_SELECT", "CLICK"
            ):
                field_actions.append({
                    "field": target,
                    "action": action,
                    "value_example": step.get("value", ""),
                })

        if not field_actions:
            return

        # Build a single text chunk for field behavior mapping
        lines = [
            f"Field Behavior Rules for {object_name or 'Unknown Object'}:",
            "Learned from successful test execution.",
            "",
        ]
        for fa in field_actions:
            lines.append(
                f"  Field: {fa['field']} → Action: {fa['action']}"
            )

        text = "\n".join(lines)

        learning = ExecutionLearning(
            project_id=project_id,
            test_case_id=None,
            test_run_id=None,
            learning_type="field_behavior",
            object_name=object_name,
            steps_pattern=field_actions,
            extra_metadata={"field_count": len(field_actions)},
        )
        db.add(learning)
        await db.flush()

        await ExecutionLearningService._embed_and_store(
            db, project_id, learning.id, "field_behavior", text
        )

    # ─── Helper Methods ─────────────────────────────────────────────

    @staticmethod
    def _extract_object_name(steps: List[Dict[str, Any]]) -> Optional[str]:
        """Extract the Salesforce object name from NAVIGATE steps."""
        for step in steps:
            if step.get("action", "").upper() == "NAVIGATE":
                value = step.get("value", "")
                # Match /lightning/o/{ObjectName}/... pattern
                match = re.search(r"/lightning/o/([^/]+)/", value)
                if match:
                    return match.group(1)
        return None

    @staticmethod
    def _detect_correct_action(
        error_msg: str, attempted_action: str, field_name: str
    ) -> Optional[str]:
        """
        Attempt to detect the correct action from common Salesforce error patterns.
        """
        error_lower = (error_msg or "").lower()

        # Picklist error patterns
        if any(phrase in error_lower for phrase in [
            "select an option from the picklist",
            "invalid picklist value",
            "bad value for restricted picklist",
        ]):
            return "SELECT"

        # Lookup error patterns
        if any(phrase in error_lower for phrase in [
            "lookup value typed but not selected",
            "select a value from the lookup",
            "no results found",
            "lookup search",
        ]):
            return "LOOKUP_SELECT"

        # Record selection pattern
        if "select" in error_lower and attempted_action == "TYPE":
            return "SELECT"

        return None

    @staticmethod
    def _create_success_text(
        object_name: Optional[str],
        description: str,
        steps: List[Dict[str, Any]],
    ) -> str:
        """Convert a successful execution into a searchable text chunk."""
        lines = [
            "Successful Test Execution Pattern:",
            f"Test Scenario: {description}",
        ]
        if object_name:
            lines.append(f"Object: {object_name}")
        lines.append("Steps:")
        for step in steps:
            action = step.get("action", "")
            target = step.get("target", "")
            value = step.get("value", "")
            if target and value:
                lines.append(f"  {action} {target} {value}")
            elif target:
                lines.append(f"  {action} {target}")
            elif value:
                lines.append(f"  {action} {value}")
            else:
                lines.append(f"  {action}")
        return "\n".join(lines)

    @staticmethod
    def _create_failure_text(
        object_name: Optional[str],
        test_name: str,
        field_name: Optional[str],
        action_attempted: Optional[str],
        correct_action: Optional[str],
        failure_reason: str,
        steps: List[Dict[str, Any]],
    ) -> str:
        """Convert a failure correction into a searchable text chunk."""
        lines = ["Failure Correction Pattern:"]
        if object_name:
            lines.append(f"Object: {object_name}")
        lines.append(f"Test: {test_name}")
        if field_name:
            lines.append(f"Field: {field_name}")
            if action_attempted:
                lines.append(f"Action Attempted: {action_attempted}")
            if correct_action:
                lines.append(f"Correct Action: {correct_action}")
        lines.append(f"Error: {failure_reason}")
        if correct_action and action_attempted:
            lines.append(
                f"Resolution: For field '{field_name}', use {correct_action} "
                f"instead of {action_attempted}"
            )
        return "\n".join(lines)

    @staticmethod
    async def _embed_and_store(
        db: AsyncSession,
        project_id: UUID,
        source_id: UUID,
        chunk_type: str,
        text: str,
    ) -> None:
        """
        Generate an OpenAI embedding for the text and store it
        as a VectorEmbedding with the specified chunk_type.
        """
        try:
            client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
            response = await client.embeddings.create(
                model=EMBEDDING_MODEL,
                input=[text[:6000]],  # Stay under token limit
            )
            embedding_vector = response.data[0].embedding

            vec = VectorEmbedding(
                project_id=project_id,
                source_type="execution_learning",
                source_id=source_id,
                chunk_type=chunk_type,
                embedding_vector=embedding_vector,
                text_chunk=text,
            )
            db.add(vec)
            logger.info(f"[LEARNING] Embedded {chunk_type} chunk ({len(text)} chars)")

        except Exception as e:
            logger.error(f"[LEARNING] Failed to embed {chunk_type} chunk: {e}")
