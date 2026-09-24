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

export type StoredVectorIdentity = Omit<StoredVectorRow, 'chunkId'>
export type CurrentChunk = { chunk: Chunk; contentHash: string }
export type PlannedUpsert = CurrentChunk & { observed: StoredVectorIdentity | null }
export type PlannedDelete = { chunkId: string; observed: StoredVectorIdentity }
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
      .map(({ chunkId, ...observed }) => ({ chunkId, observed }))
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
    else {
      const observed = row
        ? {
            contentHash: row.contentHash,
            model: row.model,
            dimension: row.dimension,
            instructionVersion: row.instructionVersion,
          }
        : null
      plan.embed.push({ ...candidate, observed })
    }
  }
  plan.embed.sort((left, right) => left.chunk.id.localeCompare(right.chunk.id))
  plan.unchanged.sort()
  return plan
}
