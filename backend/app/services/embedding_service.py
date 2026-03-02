"""
Embedding Service
Converts normalized metadata and domain models into vector embeddings
using OpenAI text-embedding-3-small model.
"""
from typing import List, Dict, Any, Optional
from uuid import UUID
import json
import logging

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import delete

from openai import AsyncOpenAI

from app.core.config import settings
from app.models.metadata_normalized import MetadataNormalized
from app.models.domain_model import DomainModel
from app.models.vector_embedding import VectorEmbedding

logger = logging.getLogger(__name__)

EMBEDDING_MODEL = "text-embedding-3-small"
# Max tokens per chunk (roughly 8000 chars to stay well under the 8191 token limit)
MAX_CHUNK_CHARS = 6000


class EmbeddingService:
    """
    Generates OpenAI embeddings from normalized metadata and domain models.
    Uses chunking strategy: per object, per flow, per validation rule.
    """

    @staticmethod
    async def generate_embeddings(db: AsyncSession, project_id: UUID) -> int:
        """
        Generate embeddings for all normalized metadata + domain models.
        Skips records that already have embeddings (incremental).
        Returns count of new embeddings created.
        """
        client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)

        # Get existing embedding source_ids to skip
        result = await db.execute(
            select(VectorEmbedding.source_id).where(VectorEmbedding.project_id == project_id)
        )
        existing_source_ids = {row[0] for row in result.all()}

        chunks = []

        # --- Chunk normalized metadata ---
        norm_result = await db.execute(
            select(MetadataNormalized).where(MetadataNormalized.project_id == project_id)
        )
        for record in norm_result.scalars().all():
            if record.id in existing_source_ids:
                continue
            text = EmbeddingService._metadata_to_text(record)
            if text:
                chunks.append({
                    "source_id": record.id,
                    "source_type": record.entity_type,
                    "text": text[:MAX_CHUNK_CHARS],
                })

        # --- Chunk domain models ---
        domain_result = await db.execute(
            select(DomainModel).where(DomainModel.project_id == project_id)
        )
        for record in domain_result.scalars().all():
            if record.id in existing_source_ids:
                continue
            text = EmbeddingService._domain_to_text(record)
            if text:
                chunks.append({
                    "source_id": record.id,
                    "source_type": "domain_model",
                    "text": text[:MAX_CHUNK_CHARS],
                })

        if not chunks:
            logger.info(f"No new chunks to embed for project {project_id}")
            return 0

        # Generate embeddings in batches (OpenAI supports batch embedding)
        BATCH_SIZE = 20
        count = 0
        for i in range(0, len(chunks), BATCH_SIZE):
            batch = chunks[i:i + BATCH_SIZE]
            texts = [c["text"] for c in batch]

            try:
                response = await client.embeddings.create(
                    model=EMBEDDING_MODEL,
                    input=texts,
                )

                for j, embedding_data in enumerate(response.data):
                    chunk = batch[j]
                    vec = VectorEmbedding(
                        project_id=project_id,
                        source_type=chunk["source_type"],
                        source_id=chunk["source_id"],
                        embedding_vector=embedding_data.embedding,
                        text_chunk=chunk["text"],
                    )
                    db.add(vec)
                    count += 1

            except Exception as e:
                logger.error(f"Embedding generation failed for batch {i}: {e}")
                continue

        await db.commit()
        logger.info(f"Generated {count} embeddings for project {project_id}")
        return count

    @staticmethod
    def _metadata_to_text(record: MetadataNormalized) -> str:
        """Convert a normalized metadata record to a searchable text chunk."""
        data = record.structured_json or {}
        entity_type = record.entity_type

        if entity_type == "object":
            lines = [
                f"Salesforce Object: {data.get('object', record.object_name)}",
                f"Label: {data.get('label', '')}",
                f"Custom: {data.get('custom', False)}",
                f"Operations: create={data.get('createable')}, edit={data.get('updateable')}, delete={data.get('deletable')}",
            ]
            # Add fields summary
            fields = data.get("fields", [])
            if fields:
                required_fields = [f for f in fields if f.get("required")]
                picklist_fields = [f for f in fields if f.get("type") == "picklist"]

                lines.append(f"Total fields: {len(fields)}")
                if required_fields:
                    lines.append(f"Required fields: {', '.join(f.get('api','') for f in required_fields)}")
                if picklist_fields:
                    for pf in picklist_fields:
                        values = [pv.get("value", "") for pv in pf.get("picklistValues", []) if pv.get("active")]
                        lines.append(f"Picklist {pf.get('api','')}: {', '.join(values[:10])}")

                # Add all field names and types
                lines.append("Fields: " + ", ".join(
                    f"{f.get('api','')}({f.get('type','')})" for f in fields[:50]
                ))

            # Add validation rules
            vrs = data.get("validation_rules", [])
            if vrs:
                lines.append(f"Validation Rules ({len(vrs)}):")
                for vr in vrs:
                    lines.append(f"  - {vr.get('name','')}: {vr.get('error_message','')}")

            return "\n".join(lines)

        elif entity_type == "flow":
            return (
                f"Salesforce Flow: {data.get('api_name', record.object_name)}\n"
                f"Label: {data.get('label', '')}\n"
                f"Process Type: {data.get('process_type', '')}\n"
                f"Status: {data.get('status', '')}\n"
                f"This flow automates a business process in Salesforce."
            )

        elif entity_type == "lwc":
            return (
                f"Lightning Web Component: {data.get('developer_name', record.object_name)}\n"
                f"Label: {data.get('label', '')}\n"
                f"Description: {data.get('description', '')}\n"
                f"This is a UI component that can be tested for rendering and interaction."
            )

        return ""

    @staticmethod
    def _domain_to_text(record: DomainModel) -> str:
        """Convert a domain model record to a searchable text chunk."""
        actions = record.actions or []
        rules = record.testing_rules or []

        lines = [
            f"Domain Model: {record.entity_name}",
            f"Available actions: {', '.join(actions)}",
            f"Testing rules ({len(rules)}):",
        ]
        for rule in rules[:20]:
            lines.append(f"  - [{rule.get('type', '')}] {rule.get('description', '')}")

        return "\n".join(lines)
