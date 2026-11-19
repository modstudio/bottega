// concern: run root roll-up
/** Selects and records the evidence kind of a completed conversation chain. */

import type { Database } from 'bun:sqlite'
import { type FailureKind, PROVIDER_UNSERVED } from '../failure/failure.ts'
import { enqueueRunRecord } from './run-outbox.ts'

export type ChainFailureMember = {
  record_id: string
  parent_run_record_id: string | null
  failure_kind: string | null
  own_failure_kind: string | null
  turn: number
  number: number
}

function memberOwnFailureKind(member: ChainFailureMember): string | null {
  return member.parent_run_record_id === null ? member.own_failure_kind : member.failure_kind
}

/** A scored chain keeps the newest failure that describes agent work, if one exists. */
export function scoredChainFailureKind(members: readonly ChainFailureMember[]): string | null {
  const ordered = [...members].sort(
    (left, right) => right.turn - left.turn || right.number - left.number,
  )
  const latest = ordered[0]
  if (!latest) return null
  const ownKinds = ordered.map(memberOwnFailureKind)
  const agentWorkIndex = ownKinds.findIndex(
    (kind) => !PROVIDER_UNSERVED.has(kind as FailureKind),
  )
  return agentWorkIndex === -1 ? memberOwnFailureKind(latest) : (ownKinds[agentWorkIndex] ?? null)
}

export function chainFailureMembers(database: Database, rootId: string): ChainFailureMember[] {
  return database
    .query(
      `SELECT record_id,parent_run_record_id,failure_kind,own_failure_kind,turn,number
         FROM run
        WHERE record_id=? OR parent_run_record_id=?`,
    )
    .all(rootId, rootId) as ChainFailureMember[]
}

function resolveRootFromLastTurnPreserving(
  database: Database,
  rootId: string,
  preserveFailureKindForTurnId: string | null,
  hasOpenQuestions: boolean,
): number {
  if (hasOpenQuestions) return 0
  const hasDelivery = Boolean(
    database
      .query('SELECT 1 FROM score WHERE run_record_id=? AND delivery IS NOT NULL')
      .get(rootId),
  )
  const scoredFailureKind = hasDelivery
    ? scoredChainFailureKind(chainFailureMembers(database, rootId))
    : null
  return database
    .query(
      `UPDATE run AS root
        SET status = (
          SELECT last.status FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC LIMIT 1
        ), error = (
          SELECT last.error FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC LIMIT 1
        ), failure_kind = (
          SELECT CASE
                   WHEN last.record_id = ? OR last.status = 'stale' OR last.failure_kind = 'abandoned'
                     THEN root.failure_kind
                   WHEN ? THEN ?
                   ELSE last.failure_kind
                 END
            FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC LIMIT 1
        ), pre_confinement = (
          SELECT last.pre_confinement FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC LIMIT 1
        ), confinement = (
          SELECT last.confinement FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC LIMIT 1
        ), tests_ran = (
          SELECT last.tests_ran FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC LIMIT 1
        ), tests_passed = (
          SELECT last.tests_passed FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC LIMIT 1
        ), tests_claim_disagrees = (
          SELECT last.tests_claim_disagrees FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC LIMIT 1
        )
      WHERE root.record_id = ?
        AND root.parent_run_record_id IS NULL
        AND root.status IN ('asking', 'ok', 'failed')
        AND (
          SELECT last.status FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC LIMIT 1
        ) IN ('ok', 'failed', 'stale')`,
    )
    .run(preserveFailureKindForTurnId, hasDelivery ? 1 : 0, scoredFailureKind, rootId).changes
}

export function rollUpRootAndEnqueue(
  database: Database,
  rootId: string,
  preserveFailureKindForTurnId: string | null,
  machine: string,
  finishedAt: string,
  hasOpenQuestions: boolean,
): number {
  const changes = resolveRootFromLastTurnPreserving(
    database,
    rootId,
    preserveFailureKindForTurnId,
    hasOpenQuestions,
  )
  enqueueRunRecord(database, rootId, machine, finishedAt)
  return changes
}
