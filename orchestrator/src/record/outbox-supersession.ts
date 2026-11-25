// concern: outbox-supersession
/** Retires quarantined mutations once a later whole-state row makes them stale. */
import type { Database } from 'bun:sqlite'
import { nowIso } from '../database/db.ts'
import type { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import { retireQuarantinedOutboxRowIfEligible } from './outbox-quarantine.ts'
import { QUARANTINED_UNRETIRED_OUTBOX_PREDICATE_SQL } from './outbox-read.ts'

export type QuarantinedOutboxRow = {
  id: number
  kind: string
  rowId: string
  payload: string
}

export type OtherOutboxRow = QuarantinedOutboxRow & {
  quarantined: boolean
  retired: boolean
}

type ContractOutboxKind = keyof typeof OUTBOX_PAYLOAD_CONTRACTS
type ParsedPayload = Record<string, unknown>
type OrderingKey = number | string
type OutboxSupersessionDefinition = {
  orderingKey: (row: QuarantinedOutboxRow, payload: ParsedPayload | null) => OrderingKey | null
  compare: (
    leftKey: OrderingKey,
    rightKey: OrderingKey,
    left: QuarantinedOutboxRow,
    right: QuarantinedOutboxRow,
  ) => number
  cannotBeSuperseded: (payload: ParsedPayload) => boolean
}

function parsedPayload(payload: string): ParsedPayload | null {
  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ParsedPayload)
      : null
  } catch {
    return null
  }
}

const byId: OutboxSupersessionDefinition = {
  orderingKey: (row, payload) => (payload === null ? null : row.id),
  compare: (leftKey, rightKey) => (leftKey as number) - (rightKey as number),
  cannotBeSuperseded: () => false,
}

const OUTBOX_ROW_COMPARATORS = {
  run: {
    ...byId,
    cannotBeSuperseded: (payload) => payload.evidenceUnvoid != null,
  },
  release: byId,
  review: byId,
  review_read: byId,
  landing: byId,
  landing_review_carry: byId,
  branch_disposal: byId,
  pull_request_ci: byId,
  score: {
    // A retry can refresh a lower-id score row in place to a newer verdict, so verdict time wins.
    orderingKey: (_row, payload) =>
      payload !== null && typeof payload.scoredAt === 'string' ? payload.scoredAt : null,
    compare: (leftKey, rightKey, left, right) =>
      (leftKey as string).localeCompare(rightKey as string) || left.id - right.id,
    cannotBeSuperseded: () => false,
  },
} as const satisfies Partial<Record<ContractOutboxKind, OutboxSupersessionDefinition>>

type SupersedableOutboxKind = keyof typeof OUTBOX_ROW_COMPARATORS

function supersessionDefinition(kind: string): OutboxSupersessionDefinition | null {
  if (!Object.hasOwn(OUTBOX_ROW_COMPARATORS, kind)) return null
  return OUTBOX_ROW_COMPARATORS[kind as SupersedableOutboxKind]
}

export function isSupersedableOutboxKind(kind: string): kind is SupersedableOutboxKind {
  return supersessionDefinition(kind) !== null
}

/** Whether this stored quarantined row may use the automatic supersession remedy. */
export function isSupersedableOutboxRow(kind: string, payload: string): boolean {
  const definition = supersessionDefinition(kind)
  const parsed = parsedPayload(payload)
  if (definition === null || parsed === null || definition.cannotBeSuperseded(parsed)) return false
  return definition.orderingKey({ id: 0, kind, rowId: '', payload }, parsed) !== null
}

/** Names the latest row that safely supersedes a quarantined whole-state mutation. */
export function supersedingOutboxRow(
  quarantined: QuarantinedOutboxRow,
  others: readonly OtherOutboxRow[],
): OtherOutboxRow | null {
  const definition = supersessionDefinition(quarantined.kind)
  const quarantinedPayload = parsedPayload(quarantined.payload)
  if (
    definition === null ||
    quarantinedPayload === null ||
    definition.cannotBeSuperseded(quarantinedPayload)
  )
    return null
  const quarantinedKey = definition.orderingKey(quarantined, quarantinedPayload)
  if (quarantinedKey === null) return null

  let superseding: OtherOutboxRow | null = null
  let supersedingKey: OrderingKey | null = null
  for (const row of others) {
    if (
      row.kind !== quarantined.kind ||
      row.rowId !== quarantined.rowId ||
      row.retired ||
      row.quarantined
    )
      continue
    const candidateKey = definition.orderingKey(row, parsedPayload(row.payload))
    if (
      candidateKey !== null &&
      definition.compare(candidateKey, quarantinedKey, row, quarantined) > 0 &&
      (superseding === null ||
        definition.compare(candidateKey, supersedingKey as OrderingKey, row, superseding) > 0)
    ) {
      superseding = row
      supersedingKey = candidateKey
    }
  }
  return superseding
}

type StoredOutboxRow = {
  id: number
  kind: string
  row_id: string
  payload: string
  quarantined_at: string | null
  retired_at: string | null
}

export const QUARANTINED_OUTBOX_ROWS_FOR_SUPERSESSION_SQL = `SELECT id,kind,row_id,payload,quarantined_at,retired_at
  FROM outbox
 WHERE ${QUARANTINED_UNRETIRED_OUTBOX_PREDICATE_SQL}
 ORDER BY id`

/** Applies supersession through the ordinary audited quarantine retirement path. */
export function retireSupersededQuarantinedOutboxRows(database: Database, at = nowIso()): number {
  const quarantined = database
    .query<StoredOutboxRow, []>(QUARANTINED_OUTBOX_ROWS_FOR_SUPERSESSION_SQL)
    .all()
  let retired = 0
  for (const row of quarantined) {
    if (!isSupersedableOutboxRow(row.kind, row.payload)) continue
    const related = database
      .query<StoredOutboxRow, [string, string]>(
        `SELECT id,kind,row_id,payload,quarantined_at,retired_at
           FROM outbox INDEXED BY outbox_row_history
          WHERE kind=? AND row_id=?
          ORDER BY id`,
      )
      .all(row.kind, row.row_id)
    const superseding = supersedingOutboxRow(
      { id: row.id, kind: row.kind, rowId: row.row_id, payload: row.payload },
      related.map((candidate) => ({
        id: candidate.id,
        kind: candidate.kind,
        rowId: candidate.row_id,
        payload: candidate.payload,
        quarantined: candidate.quarantined_at !== null,
        retired: candidate.retired_at !== null,
      })),
    )
    if (superseding === null) continue
    if (
      retireQuarantinedOutboxRowIfEligible(
        row.id,
        `superseded by ${row.kind} outbox row ${superseding.id}`,
        database,
        at,
        null,
      )
    )
      retired += 1
  }
  return retired
}
