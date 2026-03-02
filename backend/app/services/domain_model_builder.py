"""
Domain Model Builder Service
Transforms normalized metadata into semantic testing domain models.
"""
from typing import List, Dict, Any
from uuid import UUID
from datetime import datetime
import logging

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import delete

from app.models.metadata_normalized import MetadataNormalized
from app.models.domain_model import DomainModel

logger = logging.getLogger(__name__)

# Mapping rules: metadata type → testing semantics
FIELD_TYPE_TEST_MAPPING = {
    "string": "text_input_test",
    "textarea": "text_area_test",
    "email": "email_validation_test",
    "phone": "phone_format_test",
    "url": "url_validation_test",
    "currency": "currency_input_test",
    "double": "numeric_input_test",
    "int": "integer_input_test",
    "percent": "percentage_input_test",
    "date": "date_picker_test",
    "datetime": "datetime_picker_test",
    "boolean": "checkbox_test",
    "picklist": "dropdown_selection_test",
    "multipicklist": "multi_select_test",
    "reference": "lookup_field_test",
    "id": "record_id_test",
}


class DomainModelBuilder:
    """
    Reads normalized metadata and produces testing-oriented domain models.
    Maps metadata types to testing semantics.
    """

    @staticmethod
    async def build_all(db: AsyncSession, project_id: UUID) -> int:
        """
        Build domain models for all normalized metadata in a project.
        Returns the count of domain models created.
        """
        # Clear existing domain models for fresh rebuild
        await db.execute(
            delete(DomainModel).where(DomainModel.project_id == project_id)
        )

        # Fetch all normalized metadata
        result = await db.execute(
            select(MetadataNormalized).where(MetadataNormalized.project_id == project_id)
        )
        normalized_records = result.scalars().all()

        count = 0

        for record in normalized_records:
            entity_type = record.entity_type
            data = record.structured_json or {}

            if entity_type == "object":
                actions, testing_rules = DomainModelBuilder._build_object_domain(data)
            elif entity_type == "flow":
                actions, testing_rules = DomainModelBuilder._build_flow_domain(data)
            elif entity_type == "lwc":
                actions, testing_rules = DomainModelBuilder._build_lwc_domain(data)
            else:
                continue

            domain = DomainModel(
                project_id=project_id,
                entity_name=record.object_name,
                actions=actions,
                testing_rules=testing_rules,
            )
            db.add(domain)
            count += 1

        await db.commit()
        logger.info(f"Built {count} domain models for project {project_id}")
        return count

    @staticmethod
    def _build_object_domain(data: Dict) -> tuple:
        """Build domain model for a Salesforce object."""
        obj_name = data.get("object", "Unknown")
        actions = []
        testing_rules = []

        # Base CRUD actions based on object capabilities
        if data.get("createable"):
            actions.append("create")
        if data.get("updateable"):
            actions.append("edit")
        if data.get("deletable"):
            actions.append("delete")
        if data.get("queryable"):
            actions.append("view")
            actions.append("search")

        # Analyze fields for testing rules
        for field in data.get("fields", []):
            field_api = field.get("api", "")
            field_type = field.get("type", "string").lower()

            # Required field → mandatory field test
            if field.get("required"):
                testing_rules.append({
                    "type": "mandatory_field_test",
                    "field": field_api,
                    "description": f"Verify {field_api} is required and cannot be left empty",
                })

            # Picklist → dropdown test
            if field_type == "picklist" and field.get("picklistValues"):
                testing_rules.append({
                    "type": "dropdown_selection_test",
                    "field": field_api,
                    "values": [pv.get("value") for pv in field.get("picklistValues", []) if pv.get("active")],
                    "description": f"Verify {field_api} dropdown shows correct options",
                })

            # Field type specific tests
            test_type = FIELD_TYPE_TEST_MAPPING.get(field_type)
            if test_type:
                testing_rules.append({
                    "type": test_type,
                    "field": field_api,
                    "description": f"Verify {field_api} accepts valid {field_type} input",
                })

            # Unique field → uniqueness test
            if field.get("unique"):
                testing_rules.append({
                    "type": "uniqueness_test",
                    "field": field_api,
                    "description": f"Verify {field_api} rejects duplicate values",
                })

        # Validation rules → negative tests
        for vr in data.get("validation_rules", []):
            actions.append(f"validate_{vr.get('name', 'rule')}")
            testing_rules.append({
                "type": "negative_test",
                "rule": vr.get("name", ""),
                "formula": vr.get("formula", ""),
                "error_message": vr.get("error_message", ""),
                "description": f"Verify validation rule '{vr.get('name', '')}' fires correctly",
            })

        return actions, testing_rules

    @staticmethod
    def _build_flow_domain(data: Dict) -> tuple:
        """Build domain model for a Salesforce Flow."""
        flow_name = data.get("api_name", data.get("label", "Unknown"))
        process_type = data.get("process_type", "")

        actions = [
            "trigger_flow",
            "complete_flow",
            "verify_flow_outcome",
        ]

        testing_rules = [{
            "type": "business_process_test",
            "flow": flow_name,
            "process_type": process_type,
            "description": f"Verify flow '{flow_name}' executes successfully end-to-end",
        }]

        # Add specific test based on process type
        if process_type in ("Workflow", "AutoLaunchedFlow"):
            testing_rules.append({
                "type": "automated_process_test",
                "description": f"Verify automated flow '{flow_name}' triggers on correct conditions",
            })
        elif process_type == "Flow":
            testing_rules.append({
                "type": "screen_flow_test",
                "description": f"Verify screen flow '{flow_name}' UI renders and submits correctly",
            })

        return actions, testing_rules

    @staticmethod
    def _build_lwc_domain(data: Dict) -> tuple:
        """Build domain model for a Lightning Web Component."""
        lwc_name = data.get("developer_name", "Unknown")

        actions = [
            "render_component",
            "interact_with_component",
            "verify_component_output",
        ]

        testing_rules = [
            {
                "type": "ui_interaction_test",
                "component": lwc_name,
                "description": f"Verify LWC '{lwc_name}' renders correctly and responds to user interaction",
            },
            {
                "type": "component_visibility_test",
                "component": lwc_name,
                "description": f"Verify LWC '{lwc_name}' is visible on the page",
            },
        ]

        return actions, testing_rules
