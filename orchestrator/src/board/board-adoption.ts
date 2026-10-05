// concern: board-adoption
/** Plans and performs the one-time, resumable move from the local board to the hosted board. */
import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record/schema.ts'
import { writableDb, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import {
  type RecordApiClient,
  RecordApiRequestError,
  recordApiClient,
} from '../record/record-api-client.ts'
import { claimIsLive } from './board-claim-policy.ts'
import { BOARD_HOSTED_ADOPTED_KEY, boardHasAdoptedHosted } from './board-mode.ts'
import { parseAudience } from './board-policy.ts'
import {
  latestRunStatus,
  type MessageRow,
  messageRows,
  messageTags,
  rowIsLive,
} from './board-store.ts'

type LocalKind = 'notice' | 'question' | 'reply' | 'claim'
type LedgerState = 'pending' | 'uploaded' | 'refused'
type LedgerRow = {
  local_kind: LocalKind
  local_id: number
  hosted_id: string
  state: LedgerState
  refusal: string | null
}
type ClaimRow = {
  id: number
  project: string
  subject_kind: 'task' | 'path' | 'resource'
  subject_value: string
  holder_session: string | null
  note: string | null
  run_id: number | null
  lapses_at: string
  closed_at: string | null
}
type Candidate =
  | { kind: Exclude<LocalKind, 'claim'>; id: number; createdAt: string; row: MessageRow }
  | { kind: 'claim'; id: number; createdAt: string; row: ClaimRow }
type CandidateFact = {
  candidate: Candidate
  live: boolean
  accepted: boolean
  machine: boolean
  recorded: boolean
}

export type BoardAdoptionPlan = {
  total: number
  counts: Record<LocalKind, number>
  stays: Array<{ kind: LocalKind; id: number; reason: string }>
  note: string
}
export type BoardAdoptionResult = BoardAdoptionPlan & {
  status: 'plan' | 'adopted' | 'stopped'
  uploaded: number
  refused: number
  remaining: number
  message?: string
}

const emptyCounts = (): Record<LocalKind, number> => ({
  notice: 0,
  question: 0,
  reply: 0,
  claim: 0,
})

/** Pure candidate ordering: roots, then replies in thread order, then claims. */
export function orderBoardAdoptionCandidates(rows: Candidate[]): Candidate[] {
  const phase = (row: Candidate) => (row.kind === 'reply' ? 1 : row.kind === 'claim' ? 2 : 0)
  return [...rows].sort(
    (left, right) =>
      phase(left) - phase(right) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id - right.id,
  )
}

/** Pure final-mark decision. */
export function mayMarkBoardHostedAdopted(states: LedgerState[]): boolean {
  return states.every((state) => state === 'uploaded' || state === 'refused')
}

/** Pure candidate decision over facts gathered by the local adapter. */
export function selectBoardAdoptionCandidates(facts: CandidateFact[]): Candidate[] {
  return orderBoardAdoptionCandidates(
    facts
      .filter((fact) => (fact.recorded || fact.live) && !fact.accepted && !fact.machine)
      .map((fact) => fact.candidate),
  )
}

function ledger(database: Database): Map<string, LedgerRow> {
  return new Map(
    (
      database
        .query(
          'SELECT local_kind,local_id,hosted_id,state,refusal FROM board_hosted_adoption_ledger',
        )
        .all() as LedgerRow[]
    ).map((row) => [`${row.local_kind}:${row.local_id}`, row]),
  )
}

function candidateRows(
  clock: number,
  database: Database,
  recorded: Map<string, LedgerRow>,
): Candidate[] {
  const messages = messageRows(database)
  const byId = new Map(messages.map((row) => [row.id, row]))
  const messageFacts = messages.flatMap((row): CandidateFact[] => {
    if (row.kind !== 'notice' && row.kind !== 'question' && row.kind !== 'reply') return []
    const root = row.kind === 'reply' ? byId.get(row.thread_root_id!) : row
    const prior = recorded.get(`${row.kind}:${row.id}`)
    const movedRoot = root && recorded.has(`${root.kind}:${root.id}`)
    const live =
      row.kind === 'reply' && movedRoot
        ? rowIsLive({ ...root, withdrawn_at: null }, clock, database)
        : rowIsLive(row, clock, database)
    if (!root?.audience) return []
    return [
      {
        candidate: { kind: row.kind, id: row.id, createdAt: row.created_at, row },
        live,
        accepted: root.accepted_reply_id !== null,
        machine: parseAudience(root.audience).kind === 'machine',
        recorded: Boolean(prior),
      },
    ]
  })
  const claims = database.query('SELECT * FROM board_claim').all() as ClaimRow[]
  const claimFacts = claims.map(
    (row): CandidateFact => ({
      candidate: { kind: 'claim', id: row.id, createdAt: row.lapses_at, row },
      recorded: recorded.has(`claim:${row.id}`),
      live: claimIsLive({
        closed: row.closed_at !== null,
        lapsesAt: Date.parse(row.lapses_at),
        runStatus: latestRunStatus(row.run_id, database),
        now: clock,
      }),
      accepted: false,
      machine: false,
    }),
  )
  return selectBoardAdoptionCandidates([...messageFacts, ...claimFacts])
}

function runRecordId(localId: number | null, database: Database): string | null {
  if (localId === null) return null
  return (
    database
      .query<{ record_id: string | null }, [number]>('SELECT record_id FROM run WHERE id=?')
      .get(localId)?.record_id ?? null
  )
}

function lastingLocalRefusal(candidate: Candidate, database: Database): string | null {
  if (candidate.kind === 'claim' && candidate.row.run_id !== null) {
    if (!runRecordId(candidate.row.run_id, database))
      return `claim run ${candidate.row.run_id} has no hosted record id; run orch sync --backfill and rerun orch board adopt`
  }
  return null
}

function planFor(candidates: Candidate[], rows: Map<string, LedgerRow>, database: Database) {
  const counts = emptyCounts()
  const stays: BoardAdoptionPlan['stays'] = []
  for (const candidate of candidates) {
    counts[candidate.kind]++
    const recorded = rows.get(`${candidate.kind}:${candidate.id}`)
    const reason =
      recorded?.state === 'refused' ? recorded.refusal : lastingLocalRefusal(candidate, database)
    if (reason) stays.push({ kind: candidate.kind, id: candidate.id, reason })
  }
  return {
    total: candidates.length,
    counts,
    stays,
    note: 'Uploaded rows take the upload time as their creation time; absolute expiry is preserved.',
  } satisfies BoardAdoptionPlan
}

function pendingLedger(candidate: Candidate, at: string, database: Database): LedgerRow {
  return writeTransaction(() => {
    database
      .query(
        `INSERT OR IGNORE INTO board_hosted_adoption_ledger
         (local_kind,local_id,hosted_id,state,refusal,created_at,updated_at)
         VALUES (?,?,?,'pending',NULL,?,?)`,
      )
      .run(candidate.kind, candidate.id, newRecordId(), at, at)
    return database
      .query<LedgerRow, [LocalKind, number]>(
        `SELECT local_kind,local_id,hosted_id,state,refusal FROM board_hosted_adoption_ledger
         WHERE local_kind=? AND local_id=?`,
      )
      .get(candidate.kind, candidate.id)!
  }, database)
}

function refuseCandidate(
  candidate: Candidate,
  hostedId: string,
  reason: string,
  at: string,
  database: Database,
) {
  writeTransaction(() => {
    database
      .query(
        `UPDATE board_hosted_adoption_ledger SET state='refused',refusal=?,updated_at=?
         WHERE local_kind=? AND local_id=? AND hosted_id=?`,
      )
      .run(reason, at, candidate.kind, candidate.id, hostedId)
  }, database)
}

function retireCandidate(candidate: Candidate, hostedId: string, at: string, database: Database) {
  writeTransaction(() => {
    database
      .query(
        `UPDATE board_hosted_adoption_ledger SET state='uploaded',refusal=NULL,updated_at=?
         WHERE local_kind=? AND local_id=? AND hosted_id=?`,
      )
      .run(at, candidate.kind, candidate.id, hostedId)
    if (candidate.kind === 'claim')
      database
        .query(
          "UPDATE board_claim SET closed_at=?,close_reason='released' WHERE id=? AND closed_at IS NULL",
        )
        .run(at, candidate.id)
    else
      database
        .query('UPDATE board_message SET withdrawn_at=? WHERE id=? AND withdrawn_at IS NULL')
        .run(at, candidate.id)
  }, database)
}

function originalProject(row: MessageRow, root: MessageRow | undefined): string | undefined {
  return row.author_project ?? root?.author_project ?? undefined
}

async function uploadMessage(
  candidate: Extract<Candidate, { kind: 'notice' | 'question' | 'reply' }>,
  hostedId: string,
  roots: Map<number, MessageRow>,
  hostedRoots: Map<number, string>,
  client: RecordApiClient,
  database: Database,
) {
  const row = candidate.row
  const authorRunId = runRecordId(row.author_run_id, database)
  if (candidate.kind === 'reply') {
    const rootId = row.thread_root_id!
    const hostedRoot = hostedRoots.get(rootId)
    if (!hostedRoot) throw new Error(`local reply ${row.id} has no uploaded root ${rootId}`)
    await client.replyBoardMessage(hostedRoot, {
      id: hostedId,
      body: row.body,
      authorSession: row.author_session,
      authorHarness: row.author_harness,
      authorMachineId: machineId(),
      authorRunId,
    })
    return
  }
  const tags = messageTags(row.id, database).filter((tag) => tag.origin === 'sender')
  await client.postBoardMessage({
    id: hostedId,
    kind: candidate.kind,
    audience: row.audience!,
    title: row.title!,
    body: row.body,
    ackRequired: row.ack_required === 1,
    ackDeadline: row.ack_deadline,
    expiresAt: row.expires_at!,
    task: tags.find((tag) => tag.kind === 'task')?.value,
    paths: tags.filter((tag) => tag.kind === 'path').map((tag) => tag.value),
    topics: tags.filter((tag) => tag.kind === 'topic').map((tag) => tag.value),
    authorSession: row.author_session,
    authorHarness: row.author_harness,
    authorMachineId: machineId(),
    authorRunId,
    project: originalProject(row, roots.get(row.thread_root_id ?? -1)),
  })
}

async function uploadReceipts(
  messageId: number,
  hostedId: string,
  client: RecordApiClient,
  database: Database,
) {
  const receipts = database
    .query(
      `SELECT reader_session,audience_at_posting,delivered_at,acknowledged_at
       FROM board_receipt WHERE message_id=? ORDER BY reader_session`,
    )
    .all(messageId) as Array<{
    reader_session: string
    audience_at_posting: number
    delivered_at: string | null
    acknowledged_at: string | null
  }>
  for (const receipt of receipts) {
    if (!receipt.delivered_at && !receipt.acknowledged_at) continue
    await client.putBoardReceipt({
      messageId: hostedId,
      readerSession: receipt.reader_session,
      audienceAtPosting: receipt.audience_at_posting === 1,
      delivered: Boolean(receipt.delivered_at),
      acknowledged: Boolean(receipt.acknowledged_at),
    })
  }
}

async function uploadClaim(
  candidate: Extract<Candidate, { kind: 'claim' }>,
  hostedId: string,
  clock: number,
  client: RecordApiClient,
  database: Database,
) {
  const row = candidate.row
  await client.takeBoardClaim({
    id: hostedId,
    project: row.project,
    subject: `${row.subject_kind}:${row.subject_value}`,
    durationMs: Math.max(1, Date.parse(row.lapses_at) - clock),
    runId: runRecordId(row.run_id, database),
    note: row.note ?? undefined,
    holderSession: row.holder_session,
  })
}

const rateLimited = (error: unknown) =>
  error instanceof RecordApiRequestError && error.message.includes('board post rate limit reached')
const unregisteredMachine = (error: unknown) =>
  error instanceof RecordApiRequestError &&
  error.message.includes('board authorMachineId is missing, invisible, or not owned by this user')
const lastingServiceRefusal = (error: unknown) =>
  error instanceof RecordApiRequestError &&
  error.kind === 'refused' &&
  (error.message.includes('unknown or invisible board project') ||
    error.message.includes('row-level security') ||
    error.message.includes('not started by this user'))

export async function adoptHostedBoard(
  input: { confirm?: number; clock?: number; database?: Database; client?: RecordApiClient } = {},
): Promise<BoardAdoptionResult> {
  const database = input.database ?? writableDb()
  if (boardHasAdoptedHosted(database))
    throw new Error('the local board is already adopted by the hosted board; no action was taken')
  const client = input.client ?? recordApiClient()
  await client.whoami()
  await client.listBoardChanges({ after: '0', limit: 1 })
  const clock = input.clock ?? Date.now()
  const at = new Date(clock).toISOString()
  const initialLedger = ledger(database)
  const candidates = candidateRows(clock, database, initialLedger)
  const plan = planFor(candidates, initialLedger, database)
  if (input.confirm === undefined)
    return { ...plan, status: 'plan', uploaded: 0, refused: 0, remaining: plan.total }
  if (input.confirm !== plan.total)
    throw new Error(
      `confirmation ${input.confirm} does not match current candidate total ${plan.total}; rerun orch board adopt --confirm ${plan.total}`,
    )

  const roots = new Map(messageRows(database).map((row) => [row.id, row]))
  const hostedRoots = new Map<number, string>()
  const messages = candidates.filter(
    (candidate): candidate is Extract<Candidate, { kind: 'notice' | 'question' | 'reply' }> =>
      candidate.kind !== 'claim',
  )
  const claims = candidates.filter(
    (candidate): candidate is Extract<Candidate, { kind: 'claim' }> => candidate.kind === 'claim',
  )
  for (const candidate of messages) {
    const recorded = ledger(database).get(`${candidate.kind}:${candidate.id}`)
    if (recorded?.state === 'uploaded' || recorded?.state === 'refused') {
      if (candidate.kind === 'notice' || candidate.kind === 'question')
        hostedRoots.set(candidate.id, recorded.hosted_id)
      continue
    }
    const pending = pendingLedger(candidate, at, database)
    const localRefusal = lastingLocalRefusal(candidate, database)
    if (localRefusal) {
      refuseCandidate(candidate, pending.hosted_id, localRefusal, at, database)
      continue
    }
    try {
      await uploadMessage(candidate, pending.hosted_id, roots, hostedRoots, client, database)
      retireCandidate(candidate, pending.hosted_id, at, database)
      if (candidate.kind === 'notice' || candidate.kind === 'question')
        hostedRoots.set(candidate.id, pending.hosted_id)
    } catch (error) {
      if (unregisteredMachine(error))
        throw new Error(
          `this machine is not registered under the signed-in user; run orch sync on this machine, then rerun the same orch board adopt command`,
          { cause: error },
        )
      if (rateLimited(error)) {
        const remaining = candidates.filter((row) => {
          const state = ledger(database).get(`${row.kind}:${row.id}`)?.state
          return state !== 'uploaded' && state !== 'refused'
        }).length
        return {
          ...planFor(candidates, ledger(database), database),
          status: 'stopped',
          uploaded: plan.total - remaining,
          refused: 0,
          remaining,
          message: `hosted board post rate cap reached; ${remaining} rows remain; rerun the same command after the window to resume`,
        }
      }
      if (lastingServiceRefusal(error)) {
        refuseCandidate(
          candidate,
          pending.hosted_id,
          error instanceof Error ? error.message : String(error),
          at,
          database,
        )
        continue
      }
      throw error
    }
  }

  for (const candidate of messages) {
    const recorded = ledger(database).get(`${candidate.kind}:${candidate.id}`)
    if (recorded?.state === 'uploaded')
      await uploadReceipts(candidate.id, recorded.hosted_id, client, database)
  }

  for (const candidate of claims) {
    const recorded = ledger(database).get(`claim:${candidate.id}`)
    if (recorded?.state === 'uploaded' || recorded?.state === 'refused') continue
    const pending = pendingLedger(candidate, at, database)
    const localRefusal = lastingLocalRefusal(candidate, database)
    if (localRefusal) {
      refuseCandidate(candidate, pending.hosted_id, localRefusal, at, database)
      continue
    }
    try {
      await uploadClaim(candidate, pending.hosted_id, clock, client, database)
      retireCandidate(candidate, pending.hosted_id, at, database)
    } catch (error) {
      if (lastingServiceRefusal(error)) {
        refuseCandidate(
          candidate,
          pending.hosted_id,
          error instanceof Error ? error.message : String(error),
          at,
          database,
        )
        continue
      }
      throw error
    }
  }

  const finalRows = ledger(database)
  const states = candidates.map((row) => finalRows.get(`${row.kind}:${row.id}`)?.state ?? 'pending')
  if (!mayMarkBoardHostedAdopted(states))
    throw new Error('hosted board adoption is incomplete; rerun the same command')
  writeTransaction(() => {
    database
      .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
      .run(BOARD_HOSTED_ADOPTED_KEY, '1')
  }, database)
  const refused = states.filter((state) => state === 'refused').length
  return {
    ...planFor(candidates, finalRows, database),
    status: 'adopted',
    uploaded: states.length - refused,
    refused,
    remaining: 0,
  }
}
