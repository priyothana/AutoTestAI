"""
Metadata Normalizer Service
Converts raw Salesforce metadata into structured, normalized JSON.
"""
from typing import List, Dict, Any, Optional
from uuid import UUID
from datetime import datetime
import json
import logging

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import delete

from app.models.metadata_raw import MetadataRaw
from app.models.metadata_normalized import MetadataNormalized

logger = logging.getLogger(__name__)


class MetadataNormalizer:
    """
    Reads raw metadata from metadata_raw_store and produces structured
    normalized records in metadata_normalized.
    """

    @staticmethod
    async def normalize_all(db: AsyncSession, project_id: UUID) -> int:
        """
        Normalize all raw metadata for a project.
        Returns the count of normalized records created.
        """
        # Clear existing normalized data for re-processing
        await db.execute(
            delete(MetadataNormalized).where(MetadataNormalized.project_id == project_id)
        )

        # Fetch all raw metadata
        result = await db.execute(
            select(MetadataRaw).where(MetadataRaw.project_id == project_id)
        )
        raw_records = result.scalars().all()

        # Group by object
        objects_map: Dict[str, Dict[str, Any]] = {}
        fields_map: Dict[str, List[Dict]] = {}
        validation_rules_map: Dict[str, List[Dict]] = {}
        flows: List[Dict] = []
        lwc_components: List[Dict] = []

        for raw in raw_records:
            data = raw.raw_json or {}

            if raw.metadata_type == "object":
                obj_name = raw.api_name
                objects_map[obj_name] = {
                    "label": data.get("label", obj_name),
                    "custom": data.get("custom", False),
                    "createable": data.get("createable", False),
                    "updateable": data.get("updateable", False),
                    "deletable": data.get("deletable", False),
                    "queryable": data.get("queryable", False),
                }

            elif raw.metadata_type == "field":
                # api_name is "Object.FieldName"
                parts = raw.api_name.split(".", 1)
                obj_name = parts[0] if len(parts) > 1 else "Unknown"
                field_name = parts[1] if len(parts) > 1 else raw.api_name

                field_info = {
                    "api": field_name,
                    "label": data.get("label", field_name),
                    "type": data.get("type", "string"),
                    "required": not data.get("nillable", True) and not data.get("defaultedOnCreate", False),
                    "length": data.get("length"),
                    "picklistValues": [
                        {"label": pv.get("label"), "value": pv.get("value"), "active": pv.get("active")}
                        for pv in data.get("picklistValues", [])
                    ] if data.get("picklistValues") else [],
                    "referenceTo": data.get("referenceTo", []),
                    "unique": data.get("unique", False),
                    "externalId": data.get("externalId", False),
                }
                fields_map.setdefault(obj_name, []).append(field_info)

            elif raw.metadata_type == "validation_rule":
                parts = raw.api_name.split(".", 1)
                obj_name = parts[0] if len(parts) > 1 else "Unknown"
                vr_info = {
                    "name": parts[1] if len(parts) > 1 else raw.api_name,
                    "error_message": data.get("ErrorMessage", ""),
                    "formula": data.get("ErrorConditionFormula", ""),
                    "active": data.get("Active", True),
                }
                validation_rules_map.setdefault(obj_name, []).append(vr_info)

            elif raw.metadata_type == "flow":
                flows.append({
                    "api_name": raw.api_name,
                    "label": data.get("Label", raw.api_name),
                    "process_type": data.get("ProcessType", ""),
                    "status": data.get("Status", ""),
                })

            elif raw.metadata_type == "lwc":
                lwc_components.append({
                    "developer_name": raw.api_name,
                    "label": data.get("MasterLabel", raw.api_name),
                    "description": data.get("Description", ""),
                })

        count = 0

        # --- Normalize Objects with their fields & validation rules ---
        for obj_name, obj_info in objects_map.items():
            structured = {
                "object": obj_name,
                **obj_info,
                "fields": fields_map.get(obj_name, []),
                "validation_rules": validation_rules_map.get(obj_name, []),
            }
            normalized = MetadataNormalized(
                project_id=project_id,
                object_name=obj_name,
                entity_type="object",
                label=obj_info.get("label", obj_name),
                structured_json=structured,
            )
            db.add(normalized)
            count += 1

        # --- Normalize Flows ---
        for flow in flows:
            normalized = MetadataNormalized(
                project_id=project_id,
                object_name=flow["api_name"],
                entity_type="flow",
                label=flow["label"],
                structured_json=flow,
            )
            db.add(normalized)
            count += 1

        # --- Normalize LWC ---
        for lwc in lwc_components:
            normalized = MetadataNormalized(
                project_id=project_id,
                object_name=lwc["developer_name"],
                entity_type="lwc",
                label=lwc["label"],
                structured_json=lwc,
            )
            db.add(normalized)
            count += 1

        await db.commit()
        logger.info(f"Normalized {count} metadata records for project {project_id}")
        return count
