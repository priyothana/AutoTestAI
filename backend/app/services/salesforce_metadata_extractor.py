"""
Salesforce Metadata Extractor Service
Connects to Salesforce via REST/Tooling API and extracts org metadata.

Reads access tokens from project_integrations (set by OAuth callback).
"""
from typing import List, Optional, Dict, Any
from uuid import UUID
from datetime import datetime, timedelta
import logging

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func

from app.models.metadata_raw import MetadataRaw
from app.services.integration_service import IntegrationService

try:
    from simple_salesforce import Salesforce
except ImportError:
    Salesforce = None

logger = logging.getLogger(__name__)

# Metadata cache duration (don't re-fetch within this window)
CACHE_DURATION_HOURS = 24


class SalesforceMetadataExtractor:
    """
    Extracts metadata from a Salesforce org and stores it in metadata_raw_store.
    Supports: Objects, Fields, Validation Rules, Flows, Lightning Web Components.

    Reads access_token and instance_url from the project_integrations table
    (populated by the Salesforce OAuth callback).
    """

    @staticmethod
    async def _is_cache_valid(db: AsyncSession, project_id: UUID) -> bool:
        """Check if metadata was extracted recently enough to skip re-fetch."""
        result = await db.execute(
            select(func.max(MetadataRaw.created_at)).where(MetadataRaw.project_id == project_id)
        )
        last_extracted = result.scalar_one_or_none()
        if last_extracted is None:
            return False
        return datetime.utcnow() - last_extracted < timedelta(hours=CACHE_DURATION_HOURS)

    @staticmethod
    def _connect_to_salesforce(instance_url: str, access_token: str) -> Any:
        """Create a simple-salesforce connection using a decrypted access token (OAuth)."""
        if not Salesforce:
            raise RuntimeError("simple-salesforce is not installed. Run: pip install simple-salesforce")

        return Salesforce(instance_url=instance_url, session_id=access_token)

    @staticmethod
    def _connect_via_mcp(username: str, password: str, security_token: str, domain: str = "login") -> Any:
        """Create a simple-salesforce connection using MCP credentials."""
        if not Salesforce:
            raise RuntimeError("simple-salesforce is not installed. Run: pip install simple-salesforce")

        return Salesforce(
            username=username,
            password=password,
            security_token=security_token,
            domain=domain,
        )

    @staticmethod
    async def extract_metadata(
        db: AsyncSession, project_id: UUID, force_refresh: bool = False
    ) -> Dict[str, int]:
        """
        Full extraction pipeline: connect to SF, pull metadata, store raw JSON.
        Returns counts of extracted items by type.

        Supports both OAuth (access_token) and MCP (username/password/security_token).
        """
        # Check cache
        if not force_refresh and await SalesforceMetadataExtractor._is_cache_valid(db, project_id):
            logger.info(f"Metadata cache valid for project {project_id}, skipping extraction")
            count_result = await db.execute(
                select(func.count()).where(MetadataRaw.project_id == project_id)
            )
            total = count_result.scalar_one()
            return {"cached": True, "total_raw_records": total}

        # Get integration with decrypted tokens from project_integrations
        integration = await IntegrationService.get_integration(db, project_id)
        if not integration or integration.category != "salesforce":
            raise ValueError(f"No Salesforce integration found for project {project_id}")

        tokens = await IntegrationService.get_decrypted_tokens(integration)

        # --- Choose auth mode: MCP vs OAuth ---
        if integration.mcp_connected:
            username = tokens.get("username")
            password = tokens.get("password")
            security_token = tokens.get("security_token")
            if not username or not password or not security_token:
                raise ValueError(
                    f"MCP credentials incomplete for project {project_id}. Reconnect via MCP."
                )

            # Determine domain from login URL
            domain = "login"
            if integration.salesforce_login_url and "test.salesforce.com" in integration.salesforce_login_url:
                domain = "test"

            logger.info(f"Connecting to Salesforce via MCP for project {project_id}")
            sf = SalesforceMetadataExtractor._connect_via_mcp(
                username, password, security_token, domain
            )
        else:
            # OAuth path (existing)
            if not integration.instance_url:
                raise ValueError(
                    f"Salesforce integration for project {project_id} has no instance_url. "
                    "Re-authorize the OAuth connection."
                )
            access_token = tokens.get("access_token")
            if not access_token:
                raise ValueError(
                    f"Salesforce integration for project {project_id} has no access_token. "
                    "Re-authorize the OAuth connection."
                )
            logger.info(f"Connecting to Salesforce via OAuth for project {project_id} at {integration.instance_url}")
            sf = SalesforceMetadataExtractor._connect_to_salesforce(
                integration.instance_url, access_token
            )

        counts = {"object": 0, "field": 0, "validation_rule": 0, "flow": 0, "lwc": 0}

        # --- Extract SObjects ---
        try:
            sobjects = sf.describe()
            for sobj in sobjects.get("sobjects", []):
                if sobj.get("custom", False) or sobj.get("name") in [
                    "Account", "Contact", "Opportunity", "Lead", "Case"
                ]:
                    # Store the object description
                    await SalesforceMetadataExtractor._store_raw(
                        db, project_id, "object", sobj["name"], sobj
                    )
                    counts["object"] += 1

                    # Extract fields for this object
                    try:
                        obj_desc = getattr(sf, sobj["name"]).describe()
                        for field in obj_desc.get("fields", []):
                            await SalesforceMetadataExtractor._store_raw(
                                db, project_id, "field",
                                f"{sobj['name']}.{field['name']}", field
                            )
                            counts["field"] += 1
                    except Exception as e:
                        logger.warning(f"Failed to describe {sobj['name']}: {e}")
        except Exception as e:
            logger.error(f"Failed to extract SObjects: {e}")

        # --- Extract Validation Rules ---
        try:
            vr_query = "SELECT Id, EntityDefinition.QualifiedApiName, ValidationName, ErrorMessage, ErrorConditionFormula, Active FROM ValidationRule WHERE Active = true"
            vr_result = sf.toolingexecute(f"query/?q={vr_query.replace(' ', '+')}")
            for record in vr_result.get("records", []):
                api_name = f"{record.get('EntityDefinition', {}).get('QualifiedApiName', 'Unknown')}.{record.get('ValidationName', 'Unknown')}"
                await SalesforceMetadataExtractor._store_raw(
                    db, project_id, "validation_rule", api_name, record
                )
                counts["validation_rule"] += 1
        except Exception as e:
            logger.warning(f"Failed to extract Validation Rules: {e}")

        # --- Extract Flows ---
        try:
            flow_query = "SELECT Id, ApiName, Label, ProcessType, Status FROM FlowDefinitionView WHERE Status = 'Active'"
            flow_result = sf.query(flow_query)
            for record in flow_result.get("records", []):
                await SalesforceMetadataExtractor._store_raw(
                    db, project_id, "flow", record.get("ApiName", "Unknown"), record
                )
                counts["flow"] += 1
        except Exception as e:
            logger.warning(f"Failed to extract Flows: {e}")

        # --- Extract LWC metadata ---
        try:
            lwc_query = "SELECT Id, DeveloperName, MasterLabel, Description FROM LightningComponentBundle"
            lwc_result = sf.toolingexecute(f"query/?q={lwc_query.replace(' ', '+')}")
            for record in lwc_result.get("records", []):
                await SalesforceMetadataExtractor._store_raw(
                    db, project_id, "lwc", record.get("DeveloperName", "Unknown"), record
                )
                counts["lwc"] += 1
        except Exception as e:
            logger.warning(f"Failed to extract LWC: {e}")

        await db.commit()

        total = sum(counts.values())
        logger.info(f"Extracted {total} metadata records for project {project_id}: {counts}")
        return {"cached": False, "total": total, **counts}

    @staticmethod
    async def _store_raw(
        db: AsyncSession,
        project_id: UUID,
        metadata_type: str,
        api_name: str,
        raw_json: Any,
    ) -> None:
        """Upsert a raw metadata record."""
        # Check if already exists
        result = await db.execute(
            select(MetadataRaw).where(
                MetadataRaw.project_id == project_id,
                MetadataRaw.metadata_type == metadata_type,
                MetadataRaw.api_name == api_name,
            )
        )
        existing = result.scalars().first()
        if existing:
            existing.raw_json = raw_json if isinstance(raw_json, dict) else {}
            existing.created_at = datetime.utcnow()
        else:
            record = MetadataRaw(
                project_id=project_id,
                metadata_type=metadata_type,
                api_name=api_name,
                raw_json=raw_json if isinstance(raw_json, dict) else {},
            )
            db.add(record)
