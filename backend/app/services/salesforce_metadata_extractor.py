"""
Salesforce Metadata Extractor Service
Connects to Salesforce via REST/Tooling API and extracts org metadata.
"""
from typing import List, Optional, Dict, Any
from uuid import UUID
from datetime import datetime, timedelta
import json
import logging

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func

from app.models.salesforce_connection import SalesforceConnection
from app.models.metadata_raw import MetadataRaw
from app.core.config import settings

try:
    from simple_salesforce import Salesforce
except ImportError:
    Salesforce = None

try:
    from cryptography.fernet import Fernet
except ImportError:
    Fernet = None

logger = logging.getLogger(__name__)

# Metadata cache duration (don't re-fetch within this window)
CACHE_DURATION_HOURS = 24


class TokenEncryption:
    """Encrypt/decrypt Salesforce tokens using Fernet symmetric encryption."""

    @staticmethod
    def _get_key() -> bytes:
        key = settings.SALESFORCE_ENCRYPTION_KEY
        if key:
            return key.encode() if isinstance(key, str) else key
        # Auto-generate and warn (in production, this should be set in .env)
        logger.warning("SALESFORCE_ENCRYPTION_KEY not set — using auto-generated key. Tokens will not survive restarts.")
        return Fernet.generate_key()

    @staticmethod
    def encrypt(plaintext: str) -> str:
        if not Fernet:
            return plaintext  # Fallback: store unencrypted
        f = Fernet(TokenEncryption._get_key())
        return f.encrypt(plaintext.encode()).decode()

    @staticmethod
    def decrypt(ciphertext: str) -> str:
        if not Fernet:
            return ciphertext
        f = Fernet(TokenEncryption._get_key())
        return f.decrypt(ciphertext.encode()).decode()


class SalesforceMetadataExtractor:
    """
    Extracts metadata from a Salesforce org and stores it in metadata_raw_store.
    Supports: Objects, Fields, Validation Rules, Flows, Lightning Web Components.
    """

    @staticmethod
    async def save_connection(
        db: AsyncSession,
        project_id: UUID,
        instance_url: str,
        access_token: str,
        refresh_token: Optional[str],
        org_name: Optional[str],
    ) -> SalesforceConnection:
        """Save an encrypted Salesforce connection for a project."""
        # Remove any existing connection for this project
        result = await db.execute(
            select(SalesforceConnection).where(SalesforceConnection.project_id == project_id)
        )
        existing = result.scalars().first()
        if existing:
            await db.delete(existing)

        conn = SalesforceConnection(
            project_id=project_id,
            instance_url=instance_url,
            access_token=TokenEncryption.encrypt(access_token),
            refresh_token=TokenEncryption.encrypt(refresh_token) if refresh_token else None,
            org_name=org_name,
        )
        db.add(conn)
        await db.commit()
        await db.refresh(conn)
        return conn

    @staticmethod
    async def get_connection(db: AsyncSession, project_id: UUID) -> Optional[SalesforceConnection]:
        result = await db.execute(
            select(SalesforceConnection).where(SalesforceConnection.project_id == project_id)
        )
        return result.scalars().first()

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
        """Create a simple-salesforce connection."""
        if not Salesforce:
            raise RuntimeError("simple-salesforce is not installed. Run: pip install simple-salesforce")

        decrypted_token = TokenEncryption.decrypt(access_token)
        return Salesforce(instance_url=instance_url, session_id=decrypted_token)

    @staticmethod
    async def extract_metadata(
        db: AsyncSession, project_id: UUID, force_refresh: bool = False
    ) -> Dict[str, int]:
        """
        Full extraction pipeline: connect to SF, pull metadata, store raw JSON.
        Returns counts of extracted items by type.
        """
        # Check cache
        if not force_refresh and await SalesforceMetadataExtractor._is_cache_valid(db, project_id):
            logger.info(f"Metadata cache valid for project {project_id}, skipping extraction")
            count_result = await db.execute(
                select(func.count()).where(MetadataRaw.project_id == project_id)
            )
            total = count_result.scalar_one()
            return {"cached": True, "total_raw_records": total}

        # Get connection
        conn = await SalesforceMetadataExtractor.get_connection(db, project_id)
        if not conn:
            raise ValueError(f"No Salesforce connection found for project {project_id}")

        sf = SalesforceMetadataExtractor._connect_to_salesforce(conn.instance_url, conn.access_token)

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
        return {"cached": False, **counts}

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
