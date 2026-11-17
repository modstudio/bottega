// concern: record-question-recovery
/** Replays retired local question snapshots into their original hosted spaces without mutating SQLite. */

import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { db } from '../database/db.ts'
import { recordApiClient } from './record-api-client.ts'
import type { RecordQuestionClient } from './record-api-client-question.ts'
import {
  type QuestionWriteBody,
  type QuestionWriteResult,
  questionWriteSchema,
} from './record-question-contract.ts'

export type RetiredQuestionOutboxRow = { id: number; rowId: string; payload: string }
export type RestoreQuestionCandidate = {
  outboxId: number
  id: string
  number: number | null
  revision: number
  spaceId: string
  body: QuestionWriteBody
}
export type RestoreQuestionRejection = {
  outboxId: number
  id: string
  number: number | null
  reason: string
}

type ParsedPayload = Record<string, unknown> & {
  id: string
  number: number | null
  revision: number
  spaceId: string
}

function uuidFromDigest(digest: Buffer): string {
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function restoreQuestionRequestId(outboxId: number): string {
  return uuidFromDigest(createHash('sha256').update(`question-outbox-restore:${outboxId}`).digest())
}

function payloadAudit(payload: Record<string, unknown>): QuestionWriteBody['audit'] {
  const audits = Array.isArray(payload.audits) ? payload.audits : []
  const latest = audits.at(-1)
  if (latest && typeof latest === 'object') {
    const parsed = latest as Record<string, unknown>
    if (typeof parsed.action === 'string' && typeof parsed.at === 'string')
      return {
        action: parsed.action,
        actorSession: typeof parsed.actorSession === 'string' ? parsed.actorSession : null,
        at: parsed.at,
        reason: typeof parsed.reason === 'string' ? parsed.reason : null,
      }
  }
  return {
    action: 'restore',
    actorSession: null,
    at: typeof payload.updatedAt === 'string' ? payload.updatedAt : String(payload.createdAt),
    reason: null,
  }
}

function parsePayload(
  row: RetiredQuestionOutboxRow,
): RestoreQuestionCandidate | RestoreQuestionRejection {
  let payload: ParsedPayload
  try {
    const decoded = JSON.parse(row.payload) as unknown
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error()
    payload = decoded as ParsedPayload
  } catch {
    return { outboxId: row.id, id: row.rowId, number: null, reason: 'payload is not valid JSON' }
  }
  const requestId = restoreQuestionRequestId(row.id)
  const parsed = questionWriteSchema.safeParse({
    requestId,
    question: payload,
    audit: payloadAudit(payload),
  })
  if (!parsed.success)
    return {
      outboxId: row.id,
      id: typeof payload.id === 'string' ? payload.id : row.rowId,
      number: typeof payload.number === 'number' ? payload.number : null,
      reason: `payload is not a restorable question snapshot: ${parsed.error.issues[0]?.message ?? 'invalid payload'}`,
    }
  if (typeof payload.spaceId !== 'string' || !payload.spaceId)
    return {
      outboxId: row.id,
      id: parsed.data.question.id,
      number: parsed.data.question.number,
      reason: 'payload has no record space id',
    }
  return {
    outboxId: row.id,
    id: parsed.data.question.id,
    number: parsed.data.question.number,
    revision: parsed.data.question.revision,
    spaceId: payload.spaceId,
    body: parsed.data,
  }
}

export function newestRetiredQuestionPayloads(rows: readonly RetiredQuestionOutboxRow[]): {
  candidates: RestoreQuestionCandidate[]
  rejected: RestoreQuestionRejection[]
} {
  const byQuestion = new Map<string, RestoreQuestionCandidate>()
  const rejected: RestoreQuestionRejection[] = []
  for (const row of rows) {
    const parsed = parsePayload(row)
    if ('reason' in parsed) {
      rejected.push(parsed)
      continue
    }
    const current = byQuestion.get(parsed.id)
    if (
      !current ||
      parsed.revision > current.revision ||
      (parsed.revision === current.revision && parsed.outboxId > current.outboxId)
    )
      byQuestion.set(parsed.id, parsed)
  }
  return {
    candidates: [...byQuestion.values()].sort((left, right) => left.outboxId - right.outboxId),
    rejected,
  }
}

export function restoreQuestionDisposition(result: QuestionWriteResult): 'restored' | 'unchanged' {
  return result.applied ? 'restored' : 'unchanged'
}

export function restoreQuestionRefusalReason(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('status' in error)) return null
  const status = Number(error.status)
  if (!Number.isInteger(status) || status < 400 || status >= 500) return null
  return error instanceof Error ? error.message : String(error)
}

function retiredQuestionRows(database: Database): RetiredQuestionOutboxRow[] {
  return database
    .query<RetiredQuestionOutboxRow, []>(
      `SELECT id,row_id AS rowId,payload FROM outbox
       WHERE kind='question' AND retired_at IS NOT NULL AND synced_at IS NULL
       ORDER BY id`,
    )
    .all()
}

export async function restoreQuestionsCommand(
  options: { dryRun: boolean },
  ports: {
    database?: Database
    client?: RecordQuestionClient
    log: (line: string) => void
    setExitCode: (code: number) => void
  },
): Promise<void> {
  const selection = newestRetiredQuestionPayloads(retiredQuestionRows(ports.database ?? db()))
  const counts = { restored: 0, unchanged: 0, refused: selection.rejected.length, failed: 0 }
  for (const rejected of selection.rejected)
    ports.log(`${rejected.number ?? '?'}\t${rejected.id}\trefused: ${rejected.reason}`)

  if (options.dryRun) {
    for (const candidate of selection.candidates)
      ports.log(`${candidate.number ?? '?'}\t${candidate.id}\twould restore`)
    ports.log(
      `${selection.candidates.length} would restore, ${selection.rejected.length} refused, 0 failed`,
    )
    if (selection.rejected.length) ports.setExitCode(1)
    return
  }

  const client = ports.client ?? recordApiClient()
  if (!client.writeQuestion)
    throw new Error('record API predates direct question writes; release hosted-api, then retry')
  for (const candidate of selection.candidates) {
    try {
      const result = await client.writeQuestion('restore', candidate.body, {
        destinationSpaceId: candidate.spaceId,
      })
      const disposition = restoreQuestionDisposition(result)
      counts[disposition] += 1
      ports.log(`${candidate.number ?? '?'}\t${candidate.id}\t${disposition}`)
    } catch (error) {
      const reason = restoreQuestionRefusalReason(error)
      const disposition = reason ? 'refused' : 'failed'
      counts[disposition] += 1
      ports.log(
        `${candidate.number ?? '?'}\t${candidate.id}\t${disposition}: ${reason ?? (error instanceof Error ? error.message : String(error))}`,
      )
    }
  }
  ports.log(
    `${counts.restored} restored, ${counts.unchanged} unchanged, ${counts.refused} refused, ${counts.failed} failed`,
  )
  if (counts.refused || counts.failed) ports.setExitCode(1)
}
