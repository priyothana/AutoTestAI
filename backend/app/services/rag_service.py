"""
RAG (Retrieval-Augmented Generation) Service
Retrieves relevant metadata chunks based on test case descriptions
using vector similarity search.
"""
from typing import List, Dict, Any, Optional, Tuple
from uuid import UUID
import json
import logging

import numpy as np
from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from app.core.config import settings
from app.models.vector_embedding import VectorEmbedding
from app.models.rag_query_log import RagQueryLog

logger = logging.getLogger(__name__)

EMBEDDING_MODEL = "text-embedding-3-small"


def cosine_similarity(a: List[float], b: List[float]) -> float:
    """Compute cosine similarity between two vectors."""
    a_arr = np.array(a)
    b_arr = np.array(b)
    dot = np.dot(a_arr, b_arr)
    norm_a = np.linalg.norm(a_arr)
    norm_b = np.linalg.norm(b_arr)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(dot / (norm_a * norm_b))


class RAGService:
    """
    Performs RAG retrieval: embeds query text, searches vector store,
    returns top-K most relevant chunks.
    """

    @staticmethod
    async def retrieve(
        db: AsyncSession,
        project_id: UUID,
        query_text: str,
        top_k: int = 5,
        test_case_id: Optional[UUID] = None,
    ) -> List[str]:
        """
        Retrieve the most relevant metadata chunks for a given query.

        Args:
            db: Database session
            project_id: Project to search within
            query_text: The test case description or query
            top_k: Number of chunks to retrieve
            test_case_id: Optional test case ID for logging

        Returns:
            List of relevant text chunks
        """
        client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)

        # Generate query embedding
        try:
            response = await client.embeddings.create(
                model=EMBEDDING_MODEL,
                input=[query_text],
            )
            query_embedding = response.data[0].embedding
        except Exception as e:
            logger.error(f"Failed to generate query embedding: {e}")
            return []

        # Fetch all embeddings for this project
        result = await db.execute(
            select(VectorEmbedding).where(VectorEmbedding.project_id == project_id)
        )
        all_embeddings = result.scalars().all()

        if not all_embeddings:
            logger.warning(f"No embeddings found for project {project_id}")
            return []

        # Compute similarities
        scored: List[Tuple[float, str, str]] = []
        for vec in all_embeddings:
            stored_embedding = vec.embedding_vector
            if not stored_embedding:
                continue
            similarity = cosine_similarity(query_embedding, stored_embedding)
            chunk_type = getattr(vec, "chunk_type", "metadata") or "metadata"
            scored.append((similarity, vec.text_chunk, chunk_type))

        # Sort by similarity (highest first) and take top-K
        scored.sort(key=lambda x: x[0], reverse=True)
        top_results = scored[:top_k]
        top_chunks = [chunk for _, chunk, _ in top_results]

        # Track chunk source breakdown for logging
        chunk_sources: Dict[str, int] = {}
        for _, _, ct in top_results:
            chunk_sources[ct] = chunk_sources.get(ct, 0) + 1

        # Log the query and results
        try:
            log_entry = RagQueryLog(
                project_id=project_id,
                test_case_id=test_case_id,
                query_text=query_text,
                retrieved_chunks=[
                    {
                        "rank": i + 1,
                        "similarity": round(scored[i][0], 4),
                        "chunk_preview": scored[i][1][:200],
                        "chunk_type": scored[i][2],
                    }
                    for i in range(min(top_k, len(scored)))
                ],
                chunk_sources=chunk_sources if chunk_sources else None,
            )
            db.add(log_entry)
            await db.commit()
        except Exception as e:
            logger.warning(f"Failed to log RAG query: {e}")

        logger.info(
            f"RAG retrieved {len(top_chunks)} chunks for query: '{query_text[:80]}...' "
            f"(sources: {chunk_sources})"
        )
        return top_chunks

    @staticmethod
    async def build_rag_context(
        chunks: List[str],
        categorize: bool = True,
    ) -> str:
        """
        Format retrieved chunks into a context string for the LLM prompt.

        When categorize=True (default), chunks are organized into three sections:
          - SALESFORCE METADATA
          - FIELD INTERACTION RULES
          - SUCCESSFUL EXECUTION PATTERNS

        When categorize=False, chunks are listed sequentially (original behavior).
        """
        if not chunks:
            return ""

        if not categorize:
            # Original behavior — flat list of chunks
            context_parts = [
                "=== SALESFORCE ORG METADATA CONTEXT (Retrieved via RAG) ===",
                "Use the following metadata to generate accurate, org-specific Playwright test steps.",
                "This metadata describes the actual Salesforce objects, fields, flows, and components in the org.",
                "",
            ]
            for i, chunk in enumerate(chunks, 1):
                context_parts.append(f"--- Relevant Context #{i} ---")
                context_parts.append(chunk)
                context_parts.append("")
            context_parts.append("=== END OF METADATA CONTEXT ===")
            return "\n".join(context_parts)

        # Categorized mode — separate metadata from execution learning
        metadata_chunks = []
        field_rule_chunks = []
        success_pattern_chunks = []

        for chunk in chunks:
            chunk_lower = chunk.lower()
            if chunk_lower.startswith("field behavior rules"):
                field_rule_chunks.append(chunk)
            elif chunk_lower.startswith("successful test execution pattern"):
                success_pattern_chunks.append(chunk)
            elif chunk_lower.startswith("failure correction pattern"):
                field_rule_chunks.append(chunk)
            else:
                metadata_chunks.append(chunk)

        context_parts = []

        # Section 1: Salesforce Metadata
        if metadata_chunks:
            context_parts.append("=== SALESFORCE METADATA ===")
            context_parts.append(
                "Use the following metadata to generate accurate, org-specific Playwright test steps."
            )
            context_parts.append("")
            for i, chunk in enumerate(metadata_chunks, 1):
                context_parts.append(f"--- Metadata #{i} ---")
                context_parts.append(chunk)
                context_parts.append("")

        # Section 2: Field Interaction Rules (from failure corrections + field behaviors)
        if field_rule_chunks:
            context_parts.append("=== FIELD INTERACTION RULES ===")
            context_parts.append(
                "The following rules were learned from past test executions. "
                "Apply these when generating test steps to avoid known failures."
            )
            context_parts.append("")
            for i, chunk in enumerate(field_rule_chunks, 1):
                context_parts.append(f"--- Rule #{i} ---")
                context_parts.append(chunk)
                context_parts.append("")

        # Section 3: Successful Execution Patterns
        if success_pattern_chunks:
            context_parts.append("=== SUCCESSFUL EXECUTION PATTERNS ===")
            context_parts.append(
                "The following patterns were successful in past test executions. "
                "Use these as reference for generating similar test steps."
            )
            context_parts.append("")
            for i, chunk in enumerate(success_pattern_chunks, 1):
                context_parts.append(f"--- Pattern #{i} ---")
                context_parts.append(chunk)
                context_parts.append("")

        context_parts.append("=== END OF RAG CONTEXT ===")
        return "\n".join(context_parts)
