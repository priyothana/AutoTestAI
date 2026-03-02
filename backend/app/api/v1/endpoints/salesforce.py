"""
Salesforce RAG API Endpoints
All new endpoints for Salesforce metadata extraction, RAG, and AI test generation.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, delete
from uuid import UUID
from typing import Dict, Any

from app.db.session import get_db
from app.models.salesforce_connection import SalesforceConnection
from app.models.metadata_raw import MetadataRaw
from app.models.metadata_normalized import MetadataNormalized
from app.models.domain_model import DomainModel
from app.models.vector_embedding import VectorEmbedding
from app.schemas.salesforce import (
    SalesforceConnectionCreate,
    SalesforceConnectionResponse,
    MetadataExtractRequest,
    MetadataStatusResponse,
    RAGGenerateRequest,
    RAGGenerateResponse,
)
from app.services.salesforce_metadata_extractor import SalesforceMetadataExtractor
from app.services.metadata_normalizer import MetadataNormalizer
from app.services.domain_model_builder import DomainModelBuilder
from app.services.embedding_service import EmbeddingService
from app.services.rag_service import RAGService
from app.services.ai_service import AIService

router = APIRouter()


# ──────────────────────────────────────────────
# Salesforce Connection Management
# ──────────────────────────────────────────────

@router.post("/connections", response_model=SalesforceConnectionResponse)
async def create_connection(
    data: SalesforceConnectionCreate,
    db: AsyncSession = Depends(get_db),
):
    """Save a Salesforce org connection for a project."""
    try:
        conn = await SalesforceMetadataExtractor.save_connection(
            db=db,
            project_id=data.project_id,
            instance_url=data.instance_url,
            access_token=data.access_token,
            refresh_token=data.refresh_token,
            org_name=data.org_name,
        )
        return conn
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save connection: {str(e)}")


@router.get("/connections/{project_id}", response_model=SalesforceConnectionResponse)
async def get_connection(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get the Salesforce connection for a project."""
    conn = await SalesforceMetadataExtractor.get_connection(db, project_id)
    if not conn:
        raise HTTPException(status_code=404, detail="No Salesforce connection found for this project")
    return conn


@router.delete("/connections/{connection_id}", status_code=204)
async def delete_connection(
    connection_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Delete a Salesforce connection."""
    result = await db.execute(
        select(SalesforceConnection).where(SalesforceConnection.id == connection_id)
    )
    conn = result.scalars().first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")
    await db.delete(conn)
    await db.commit()
    return None


# ──────────────────────────────────────────────
# Metadata Extraction Pipeline
# ──────────────────────────────────────────────

@router.post("/extract/{project_id}")
async def extract_metadata(
    project_id: UUID,
    force_refresh: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """
    Trigger the full metadata extraction pipeline:
    1. Extract raw metadata from Salesforce
    2. Normalize into structured format
    3. Build domain models
    4. Generate embeddings
    """
    try:
        # Step 1: Extract raw metadata
        extraction_result = await SalesforceMetadataExtractor.extract_metadata(
            db, project_id, force_refresh=force_refresh
        )

        # If using cache, skip remaining steps
        if extraction_result.get("cached"):
            return {
                "status": "cached",
                "message": "Metadata is up-to-date (cached). Use force_refresh=true to re-extract.",
                "details": extraction_result,
            }

        # Step 2: Normalize metadata
        normalized_count = await MetadataNormalizer.normalize_all(db, project_id)

        # Step 3: Build domain models
        domain_count = await DomainModelBuilder.build_all(db, project_id)

        # Step 4: Generate embeddings
        embedding_count = await EmbeddingService.generate_embeddings(db, project_id)

        return {
            "status": "completed",
            "message": "Metadata extraction pipeline completed successfully",
            "details": {
                "raw_extracted": extraction_result,
                "normalized_records": normalized_count,
                "domain_models": domain_count,
                "embeddings_generated": embedding_count,
            },
        }

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Extraction pipeline failed: {str(e)}")


@router.get("/metadata-status/{project_id}", response_model=MetadataStatusResponse)
async def get_metadata_status(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Check the current metadata status for a project."""
    raw_count = (await db.execute(
        select(func.count()).select_from(MetadataRaw).where(MetadataRaw.project_id == project_id)
    )).scalar_one()

    normalized_count = (await db.execute(
        select(func.count()).select_from(MetadataNormalized).where(MetadataNormalized.project_id == project_id)
    )).scalar_one()

    domain_count = (await db.execute(
        select(func.count()).select_from(DomainModel).where(DomainModel.project_id == project_id)
    )).scalar_one()

    embedding_count = (await db.execute(
        select(func.count()).select_from(VectorEmbedding).where(VectorEmbedding.project_id == project_id)
    )).scalar_one()

    last_extracted = (await db.execute(
        select(func.max(MetadataRaw.created_at)).where(MetadataRaw.project_id == project_id)
    )).scalar_one_or_none()

    return MetadataStatusResponse(
        project_id=project_id,
        has_metadata=raw_count > 0,
        raw_count=raw_count,
        normalized_count=normalized_count,
        domain_model_count=domain_count,
        embedding_count=embedding_count,
        last_extracted_at=last_extracted,
    )


# ──────────────────────────────────────────────
# RAG-Augmented Test Generation
# ──────────────────────────────────────────────

@router.post("/generate-with-rag", response_model=RAGGenerateResponse)
async def generate_with_rag(
    request: RAGGenerateRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Generate Playwright test steps using RAG-retrieved Salesforce metadata.

    Flow:
    1. Check if metadata exists for this project
    2. Retrieve relevant chunks via RAG
    3. Build enriched prompt with RAG context
    4. Call LLM to generate test steps
    """
    try:
        # Check if embeddings exist
        embedding_count = (await db.execute(
            select(func.count()).select_from(VectorEmbedding).where(
                VectorEmbedding.project_id == request.project_id
            )
        )).scalar_one()

        provider = request.provider
        model = request.model

        if embedding_count == 0:
            # No metadata — fall back to standard generation
            result = await AIService.generate_test_case(request.prompt, provider=provider, model=model)
            return RAGGenerateResponse(
                **result,
                rag_context_used=False,
                retrieved_chunks=[],
                model_provider=provider,
            )

        # Retrieve relevant chunks via RAG
        retrieved_chunks = await RAGService.retrieve(
            db=db,
            project_id=request.project_id,
            query_text=request.prompt,
            top_k=request.top_k,
            test_case_id=request.test_case_id,
        )

        if not retrieved_chunks:
            # No relevant chunks found — fall back to standard generation
            result = await AIService.generate_test_case(request.prompt, provider=provider, model=model)
            return RAGGenerateResponse(
                **result,
                rag_context_used=False,
                retrieved_chunks=[],
                model_provider=provider,
            )

        # Build RAG context and generate with enriched prompt
        rag_context = await RAGService.build_rag_context(retrieved_chunks)
        result = await AIService.generate_test_case_with_rag(request.prompt, rag_context, provider=provider, model=model)

        return RAGGenerateResponse(
            **result,
            rag_context_used=True,
            retrieved_chunks=retrieved_chunks[:3],  # Return first 3 for transparency
            model_provider=provider,
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"RAG generation failed: {str(e)}")
