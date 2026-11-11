// concern: ruling-list
/** Reads ruling history for adapters. Must not know CLI grammar or printing. */

import {
  type RulingChanges,
  type RulingListRow,
  RulingListSchema,
} from '../../../shared/orch-contract.ts'
import { db } from '../database/db.ts'
import { taskFlowStore } from '../workflow/task-flow-store.ts'
import { collectChangeCursor } from './collect-change.ts'

type RulingListOptions = {
  since?: string
  changedAfter?: number | null
  kind: 'workflow' | 'run' | 'all'
}

export function listRulings(options: RulingListOptions): RulingListRow[] {
  return queryRulings(options).rows
}

/** The rows changed after the cursor, with the snapshot the query was bounded by. */
export function listRulingChanges(
  options: RulingListOptions & { changedAfter: number },
): RulingChanges {
  const result = queryRulings(options)
  if (result.cursor === null) throw new Error('unreachable: a changed-after query has a cursor')
  return { cursor: result.cursor, rows: result.rows }
}

function queryRulings(options: RulingListOptions): {
  cursor: number | null
  rows: RulingListRow[]
} {
  if (options.since) {
    if (!Number.isFinite(Date.parse(options.since))) throw new Error('--since must be an ISO date')
  }
  const after = options.changedAfter ?? null
  const cursor = after === null ? null : collectChangeCursor()
  const rows = taskFlowStore(db()).rulingRows({
    kind: options.kind,
    ...(options.since ? { since: options.since } : {}),
    after,
    cursor,
  })
  const parsed = RulingListSchema.parse(
    rows.map(({ number, ...row }) => ({
      id: number,
      ...row,
    })),
  )
  return { cursor, rows: parsed }
}
