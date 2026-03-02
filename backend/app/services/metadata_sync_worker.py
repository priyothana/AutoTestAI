"""
Metadata Sync Worker
Orchestrates metadata extraction and pushes it through the existing
Normalizer → DomainModelBuilder → EmbeddingService pipeline.
"""
from uuid import UUID
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func

from app.models.project_integration import ProjectIntegration
from app.models.metadata_raw import MetadataRaw
from app.models.metadata_normalized import MetadataNormalized
from app.models.domain_model import DomainModel
from app.models.vector_embedding import VectorEmbedding
from app.services.integration_service import IntegrationService
from app.services.salesforce_metadata_extractor import SalesforceMetadataExtractor
from app.services.metadata_normalizer import MetadataNormalizer
from app.services.domain_model_builder import DomainModelBuilder
from app.services.embedding_service import EmbeddingService


class MetadataSyncWorker:

    @staticmethod
    async def sync_metadata(db: AsyncSession, project_id: UUID) -> dict:
        """
        Main entry point. Reads the integration type and runs the
        appropriate sync pipeline.

        Returns a dict with sync results / counts.
        """
        integration = await IntegrationService.get_integration(db, project_id)

        if not integration:
            return {
                "status": "no_integration",
                "message": "No integration found for this project. Connect first.",
            }

        if integration.status not in ("connected",):
            return {
                "status": "error",
                "message": f"Integration is in '{integration.status}' state. Reconnect first.",
            }

        try:
            # Mark as syncing
            await IntegrationService.update_sync_status(db, integration, "syncing")

            if integration.category == "salesforce":
                result = await MetadataSyncWorker._sync_salesforce(db, project_id, integration)
            elif integration.category == "web_app":
                result = await MetadataSyncWorker._sync_web_app(db, project_id, integration)
            else:
                result = {
                    "status": "error",
                    "message": f"Unsupported integration category: {integration.category}",
                }

            # Mark as connected (done syncing)
            if result.get("status") != "error":
                await IntegrationService.update_sync_status(db, integration, "connected")
            else:
                await IntegrationService.update_sync_status(
                    db, integration, "error", result.get("message")
                )

            return result

        except Exception as e:
            await IntegrationService.update_sync_status(
                db, integration, "error", str(e)
            )
            return {
                "status": "error",
                "message": f"Sync failed: {str(e)}",
            }

    @staticmethod
    async def _sync_salesforce(
        db: AsyncSession,
        project_id: UUID,
        integration: ProjectIntegration,
    ) -> dict:
        """
        Salesforce sync pipeline:
        1. Extract raw metadata via Salesforce APIs
        2. Normalize
        3. Build domain models
        4. Generate embeddings
        """
        # Step 1: Extract raw metadata
        extraction_result = await SalesforceMetadataExtractor.extract_metadata(
            db, project_id, force_refresh=True
        )

        # Step 2: Normalize
        normalized_count = await MetadataNormalizer.normalize_all(db, project_id)

        # Step 3: Build domain models
        domain_count = await DomainModelBuilder.build_all(db, project_id)

        # Step 4: Generate embeddings
        embedding_count = await EmbeddingService.generate_embeddings(db, project_id)

        return {
            "status": "completed",
            "message": "Salesforce metadata synced successfully",
            "raw_count": extraction_result.get("total", 0) if isinstance(extraction_result, dict) else 0,
            "normalized_count": normalized_count,
            "domain_model_count": domain_count,
            "embedding_count": embedding_count,
        }

    @staticmethod
    async def _sync_web_app(
        db: AsyncSession,
        project_id: UUID,
        integration: ProjectIntegration,
    ) -> dict:
        """
        Web App sync — minimal for v1.
        Just stores the connection metadata; future: crawler support.
        """
        return {
            "status": "completed",
            "message": (
                f"Web App integration stored. "
                f"Base URL: {integration.base_url}. "
                f"Future versions will support site crawling for metadata extraction."
            ),
            "raw_count": 0,
            "normalized_count": 0,
            "domain_model_count": 0,
            "embedding_count": 0,
        }

    @staticmethod
    async def get_sync_counts(db: AsyncSession, project_id: UUID) -> dict:
        """Get the current metadata counts for a project."""
        raw = (await db.execute(
            select(func.count()).select_from(MetadataRaw).where(MetadataRaw.project_id == project_id)
        )).scalar_one()

        normalized = (await db.execute(
            select(func.count()).select_from(MetadataNormalized).where(MetadataNormalized.project_id == project_id)
        )).scalar_one()

        domain = (await db.execute(
            select(func.count()).select_from(DomainModel).where(DomainModel.project_id == project_id)
        )).scalar_one()

        embeddings = (await db.execute(
            select(func.count()).select_from(VectorEmbedding).where(VectorEmbedding.project_id == project_id)
        )).scalar_one()

        return {
            "raw_count": raw,
            "normalized_count": normalized,
            "domain_model_count": domain,
            "embedding_count": embeddings,
        }
