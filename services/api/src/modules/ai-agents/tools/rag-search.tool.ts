/**
 * RAG Search Tool — Vector Similarity Retrieval
 *
 * Wraps the existing retrieveRagChunks function from generation.service.ts.
 * Agents call this to retrieve relevant metadata chunks from pgvector.
 */
import { retrieveRagChunks } from '../../test-generation/generation.service.js'
import { createModuleLogger } from '../../../shared/logger/index.js'

const log = createModuleLogger('rag-search-tool')

export interface RagSearchInput {
  projectId: string
  query:     string
  topK?:     number  // default: 10
}

export interface RagSearchOutput {
  chunks: string[]
  count:  number
}

/**
 * Retrieve semantically similar metadata chunks for a project.
 * Returns an empty array (not an error) if no embeddings exist.
 */
export async function ragSearchTool(input: RagSearchInput): Promise<RagSearchOutput> {
  const { projectId, query, topK = 10 } = input

  try {
    const chunks = await retrieveRagChunks(projectId, query, topK)
    log.info(
      { projectId, query: query.slice(0, 60), count: chunks.length },
      '[RAG-TOOL] Retrieved chunks',
    )
    return { chunks, count: chunks.length }
  } catch (err) {
    log.warn({ err, projectId, query }, '[RAG-TOOL] Failed — returning empty')
    return { chunks: [], count: 0 }
  }
}
