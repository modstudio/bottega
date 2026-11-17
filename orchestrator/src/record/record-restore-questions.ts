// concern: record-question-recovery
/** Replays retired local question snapshots into their canonical hosted spaces without mutating SQLite. */

import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { db } from '../database/db.ts'
import { recordApiClient } from './record-api-client.ts'
import type { RecordWriteDestination } from './record-api-client-paths.ts'
import {
  type RecordQuestionClient,
  requireQuestionWriteClient,
} from './record-api-client-question.ts'
import {
  type QuestionWriteBody,
  type QuestionWriteResult,
  questionAuditSchema,
  questionWriteSchema,
} from './record-question-contract.ts'
import {
  QuestionWriteIdentityError,
  questionWriteDestinations,
} from './record-question-destination.ts'

export type RetiredQuestionOutboxRow = { id: number; rowId: string; payload: string }
export type RestoreQuestionCandidate = {
  outboxId: number
  id: string
  number: number | null
  revision: number
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
  const parsed = questionAuditSchema.safeParse(latest)
  if (parsed.success) return parsed.data
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
  return {
    outboxId: row.id,
    id: parsed.data.question.id,
    number: parsed.data.question.number,
    revision: parsed.data.question.revision,
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

function restoreQuestionDisposition(result: QuestionWriteResult): 'restored' | 'unchanged' {
  return result.replayed || !result.applied ? 'unchanged' : 'restored'
}

export function restoreQuestionRefusalReason(error: unknown): string | null {
  if (
    error instanceof Error &&
    'kind' in error &&
    (error.kind === 'refused' || error.kind === 'conflict')
  )
    return error.message
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

type RestoreCounts = { restored: number; unchanged: number; refused: number; failed: number }
type RestoreAttempt = { disposition: keyof RestoreCounts; reason?: string }
type RestoreDestination =
  | { destination: RecordWriteDestination }
  | { reason: string; disposition: 'refused' | 'failed' }

async function resolveRestoreDestination(
  candidate: RestoreQuestionCandidate,
  resolve: (projectId: string | null) => Promise<RecordWriteDestination>,
): Promise<RestoreDestination> {
  try {
    return { destination: await resolve(candidate.body.question.projectId) }
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      disposition: error instanceof QuestionWriteIdentityError ? 'failed' : 'refused',
    }
  }
}

async function restoreCandidate(
  candidate: RestoreQuestionCandidate,
  client: RecordQuestionClient,
  destination: RecordWriteDestination,
): Promise<RestoreAttempt> {
  try {
    const result = await client.writeQuestion!('restore', candidate.body, {
      destinationSpaceId: destination.destinationSpaceId,
    })
    return { disposition: restoreQuestionDisposition(result) }
  } catch (error) {
    const refused = restoreQuestionRefusalReason(error)
    return {
      disposition: refused ? 'refused' : 'failed',
      reason: refused ?? (error instanceof Error ? error.message : String(error)),
    }
  }
}

async function reportResolvedCandidate(
  candidate: RestoreQuestionCandidate,
  destination: RecordWriteDestination,
  dryRun: boolean,
  client: RecordQuestionClient,
  log: (line: string) => void,
): Promise<RestoreAttempt | null> {
  if (dryRun) {
    log(
      `${candidate.number ?? '?'}\t${candidate.id}\twould restore to ${destination.destinationSpaceId}`,
    )
    return null
  }
  const attempt = await restoreCandidate(candidate, client, destination)
  log(
    `${candidate.number ?? '?'}\t${candidate.id}\t${attempt.disposition}${attempt.reason ? `: ${attempt.reason}` : ''}`,
  )
  return attempt
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
  const database = ports.database ?? db()
  const selection = newestRetiredQuestionPayloads(retiredQuestionRows(database))
  const counts = { restored: 0, unchanged: 0, refused: selection.rejected.length, failed: 0 }
  let wouldRestore = 0
  for (const rejected of selection.rejected)
    ports.log(`${rejected.number ?? '?'}\t${rejected.id}\trefused: ${rejected.reason}`)

  const client = ports.client ?? recordApiClient()
  const writeClient = options.dryRun ? client : requireQuestionWriteClient(client)
  const destination = questionWriteDestinations({
    database,
    whoami: () =>
      client.whoami
        ? client.whoami()
        : Promise.reject(
            new Error('record API predates identity reads; release hosted-api, then retry'),
          ),
  })
  for (const candidate of selection.candidates) {
    const resolution = await resolveRestoreDestination(candidate, destination)
    if ('reason' in resolution) {
      counts[resolution.disposition] += 1
      ports.log(
        `${candidate.number ?? '?'}\t${candidate.id}\t${resolution.disposition}: ${resolution.reason}`,
      )
      if (resolution.disposition === 'failed') break
      continue
    }
    const attempt = await reportResolvedCandidate(
      candidate,
      resolution.destination,
      options.dryRun,
      writeClient,
      ports.log,
    )
    if (!attempt) {
      wouldRestore += 1
      continue
    }
    counts[attempt.disposition] += 1
  }
  if (options.dryRun) {
    ports.log(`${wouldRestore} would restore, ${counts.refused} refused, ${counts.failed} failed`)
    if (counts.refused || counts.failed) ports.setExitCode(1)
    return
  }
  ports.log(
    `${counts.restored} restored, ${counts.unchanged} unchanged, ${counts.refused} refused, ${counts.failed} failed`,
  )
  if (counts.refused || counts.failed) ports.setExitCode(1)
}
