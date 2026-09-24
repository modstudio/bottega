// concern: retrieval-refresh-plan
/** Decides how the current document corpus changes the stored vector set. */

import { EMBEDDING_DIMENSION, EMBEDDING_MODEL, INSTRUCTION_VERSION } from './contract.ts'
import type { Chunk } from './corpus/chunks.ts'

export type StoredVectorRow = {
  chunkId: string
  contentHash: string
  model: string
  dimension: number
  instructionVersion: string
}

export type CurrentChunk = { chunk: Chunk; contentHash: string }
export type PlannedUpsert = CurrentChunk & { observedContentHash: string | null }
export type PlannedDelete = { chunkId: string; observedContentHash: string }
export type RefreshPlan = {
  embed: PlannedUpsert[]
  delete: PlannedDelete[]
  unchanged: string[]
}

export function planRefresh(current: CurrentChunk[], stored: StoredVectorRow[]): RefreshPlan {
  const currentIds = new Set(current.map(({ chunk }) => chunk.id))
  const storedById = new Map(stored.map((row) => [row.chunkId, row]))
  const plan: RefreshPlan = {
    embed: [],
    delete: stored
      .filter((row) => !currentIds.has(row.chunkId))
      .map((row) => ({ chunkId: row.chunkId, observedContentHash: row.contentHash }))
      .sort((left, right) => left.chunkId.localeCompare(right.chunkId)),
    unchanged: [],
  }
  for (const candidate of current) {
    const row = storedById.get(candidate.chunk.id)
    const matches =
      row?.contentHash === candidate.contentHash &&
      row.model === EMBEDDING_MODEL &&
      row.dimension === EMBEDDING_DIMENSION &&
      row.instructionVersion === INSTRUCTION_VERSION
    if (matches) plan.unchanged.push(candidate.chunk.id)
    else plan.embed.push({ ...candidate, observedContentHash: row?.contentHash ?? null })
  }
  plan.embed.sort((left, right) => left.chunk.id.localeCompare(right.chunk.id))
  plan.unchanged.sort()
  return plan
}
