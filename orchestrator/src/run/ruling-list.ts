// concern: ruling-list
/** Reads ruling history for adapters. Must not know CLI grammar or printing. */

import { z } from 'zod'
import {
  type RulingChanges,
  type RulingListRow,
  RulingListSchema,
} from '../../../shared/orch-contract.ts'
import { db } from '../database/db.ts'
import { questionRulings } from '../question-store/question-store-read.ts'

type RulingListOptions = {
  since?: string
  changedAfter?: number | null
  kind: 'workflow' | 'run' | 'all'
}

export async function listRulings(options: RulingListOptions): Promise<RulingListRow[]> {
  return (await queryRulings(options)).rows
}

/** The rows changed after the cursor, with the snapshot the query was bounded by. */
export async function listRulingChanges(
  options: RulingListOptions & { changedAfter: number },
): Promise<RulingChanges> {
  const result = await queryRulings(options)
  if (result.cursor === null) throw new Error('unreachable: a changed-after query has a cursor')
  return { cursor: result.cursor, rows: result.rows }
}

async function queryRulings(options: RulingListOptions): Promise<{
  cursor: number | null
  rows: RulingListRow[]
}> {
  if (options.since) {
    if (!Number.isFinite(Date.parse(options.since))) throw new Error('--since must be an ISO date')
  }
  const after = options.changedAfter ?? null
  const result = await questionRulings(db(), {
    kind: options.kind,
    ...(options.since ? { since: options.since } : {}),
    ...(after === null ? {} : { changedAfter: String(after) }),
  })
  const rows = result.items
  const cursor = result.cursor === undefined ? null : Number(result.cursor)
  const parsed = z.array(RulingListSchema.element.strip()).parse(
    rows.map(({ number, ...row }) => ({
      id: number,
      ...row,
    })),
  )
  return { cursor, rows: parsed }
}
