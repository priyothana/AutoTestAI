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
        scored: List[Tuple[float, str]] = []
        for vec in all_embeddings:
            stored_embedding = vec.embedding_vector
            if not stored_embedding:
                continue
            similarity = cosine_similarity(query_embedding, stored_embedding)
            scored.append((similarity, vec.text_chunk))

        # Sort by similarity (highest first) and take top-K
        scored.sort(key=lambda x: x[0], reverse=True)
        top_chunks = [chunk for _, chunk in scored[:top_k]]

        # Log the query and results
        try:
            log_entry = RagQueryLog(
                project_id=project_id,
                test_case_id=test_case_id,
                query_text=query_text,
                retrieved_chunks=[
                    {"rank": i + 1, "similarity": round(scored[i][0], 4), "chunk_preview": scored[i][1][:200]}
                    for i in range(min(top_k, len(scored)))
                ],
            )
            db.add(log_entry)
            await db.commit()
        except Exception as e:
            logger.warning(f"Failed to log RAG query: {e}")

        logger.info(f"RAG retrieved {len(top_chunks)} chunks for query: '{query_text[:80]}...'")
        return top_chunks

    @staticmethod
    async def build_rag_context(chunks: List[str]) -> str:
        """
        Format retrieved chunks into a context string for the LLM prompt.
        """
        if not chunks:
            return ""

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
