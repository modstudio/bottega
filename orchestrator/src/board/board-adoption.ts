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
import {
  type AdoptionCandidate as Candidate,
  type AdoptionCandidateFact as CandidateFact,
  isTerminalLedgerState,
  type LedgerState,
  type LocalKind,
  mayMarkBoardHostedAdopted,
  selectBoardAdoptionCandidates,
  uploadErrorDisposition,
} from './board-adoption-policy.ts'
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

type LedgerRow = {
  local_kind: LocalKind
  local_id: number
  hosted_id: string
  state: LedgerState
  refusal: string | null
}

type BoardAdoptionPlan = {
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
  skippedReceipts: number
  message?: string
}

const emptyCounts = (): Record<LocalKind, number> => ({
  notice: 0,
  question: 0,
  reply: 0,
  claim: 0,
})

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

type CandidateRow = MessageRow | ClaimRow
const candidateKey = (candidate: Candidate) => `${candidate.kind}:${candidate.id}`

function candidateRows(
  clock: number,
  database: Database,
  recorded: Map<string, LedgerRow>,
): { candidates: Candidate[]; rows: Map<string, CandidateRow> } {
  const messages = messageRows(database)
  const byId = new Map(messages.map((row) => [row.id, row]))
  const rows = new Map<string, CandidateRow>()
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
        candidate: { kind: row.kind, id: row.id, createdAt: row.created_at },
        live,
        accepted: root.accepted_reply_id !== null,
        machine: parseAudience(root.audience).kind === 'machine',
        recorded: isTerminalLedgerState(prior?.state),
      },
    ]
  })
  const claims = database.query('SELECT * FROM board_claim').all() as ClaimRow[]
  const claimFacts = claims.map(
    (row): CandidateFact => ({
      candidate: { kind: 'claim', id: row.id, createdAt: row.lapses_at },
      recorded: isTerminalLedgerState(recorded.get(`claim:${row.id}`)?.state),
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
  for (const row of messages) rows.set(`${row.kind}:${row.id}`, row)
  for (const row of claims) rows.set(`claim:${row.id}`, row)
  return { candidates: selectBoardAdoptionCandidates([...messageFacts, ...claimFacts]), rows }
}

function runRecordId(localId: number | null, database: Database): string | null {
  if (localId === null) return null
  return (
    database
      .query<{ record_id: string | null }, [number]>('SELECT record_id FROM run WHERE id=?')
      .get(localId)?.record_id ?? null
  )
}

function lastingLocalRefusal(
  candidate: Candidate,
  row: CandidateRow,
  database: Database,
): string | null {
  if (candidate.kind === 'reply') {
    const message = row as MessageRow
    const root = database
      .query<{ kind: LocalKind }, [number]>('SELECT kind FROM board_message WHERE id=?')
      .get(message.thread_root_id!)
    const rootLedger = root
      ? ledger(database).get(`${root.kind}:${message.thread_root_id}`)
      : undefined
    if (rootLedger?.state === 'refused')
      return `thread root ${message.thread_root_id} was refused by the hosted service: ${rootLedger.refusal}`
  }
  if (candidate.kind === 'claim' && (row as ClaimRow).run_id !== null) {
    const claim = row as ClaimRow
    if (!runRecordId(claim.run_id, database))
      return `claim run ${claim.run_id} has no hosted record id; run orch sync --backfill and rerun orch board adopt`
  }
  return null
}

function planFor(
  candidates: Candidate[],
  localRows: Map<string, CandidateRow>,
  rows: Map<string, LedgerRow>,
  database: Database,
) {
  const counts = emptyCounts()
  const stays: BoardAdoptionPlan['stays'] = []
  for (const candidate of candidates) {
    const recorded = rows.get(`${candidate.kind}:${candidate.id}`)
    const reason =
      recorded?.state === 'refused'
        ? recorded.refusal
        : lastingLocalRefusal(candidate, localRows.get(candidateKey(candidate))!, database)
    if (reason) stays.push({ kind: candidate.kind, id: candidate.id, reason })
    else counts[candidate.kind]++
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

function retireCandidate(
  candidate: Candidate,
  mintedId: string,
  hostedId: string,
  at: string,
  database: Database,
) {
  writeTransaction(() => {
    database
      .query(
        `UPDATE board_hosted_adoption_ledger
         SET hosted_id=?,state='uploaded',refusal=NULL,updated_at=?
         WHERE local_kind=? AND local_id=? AND hosted_id=?`,
      )
      .run(hostedId, at, candidate.kind, candidate.id, mintedId)
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
  candidate: Candidate,
  row: MessageRow,
  hostedId: string,
  roots: Map<number, MessageRow>,
  hostedRoots: Map<number, string>,
  client: RecordApiClient,
  database: Database,
): Promise<string> {
  const authorRunId = runRecordId(row.author_run_id, database)
  if (candidate.kind === 'reply') {
    const rootId = row.thread_root_id!
    const hostedRoot = hostedRoots.get(rootId)
    if (!hostedRoot) throw new Error(`local reply ${row.id} has no uploaded root ${rootId}`)
    const uploaded = await client.replyBoardMessage(hostedRoot, {
      id: hostedId,
      body: row.body,
      authorSession: row.author_session,
      authorHarness: row.author_harness,
      authorMachineId: machineId(),
      authorRunId,
    })
    return uploaded.id
  }
  if (candidate.kind === 'claim') throw new Error(`claim ${candidate.id} is not a board message`)
  const tags = messageTags(row.id, database).filter((tag) => tag.origin === 'sender')
  const uploaded = await client.postBoardMessage({
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
  return uploaded.id
}

async function uploadReceipts(
  messageId: number,
  hostedId: string,
  client: RecordApiClient,
  database: Database,
): Promise<number> {
  let skipped = 0
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
    try {
      await client.putBoardReceipt({
        messageId: hostedId,
        readerSession: receipt.reader_session,
        audienceAtPosting: receipt.audience_at_posting === 1,
        delivered: Boolean(receipt.delivered_at),
        acknowledged: Boolean(receipt.acknowledged_at),
      })
    } catch (error) {
      if (error instanceof RecordApiRequestError && error.kind === 'refused') skipped++
      else throw error
    }
  }
  return skipped
}

async function uploadClaim(
  row: ClaimRow,
  hostedId: string,
  clock: () => number,
  client: RecordApiClient,
  database: Database,
): Promise<string | null> {
  const remaining = Date.parse(row.lapses_at) - clock()
  if (remaining <= 0) return null
  const uploaded = await client.takeBoardClaim({
    id: hostedId,
    project: row.project,
    subject: `${row.subject_kind}:${row.subject_value}`,
    durationMs: remaining,
    runId: runRecordId(row.run_id, database),
    note: row.note ?? undefined,
    holderSession: row.holder_session,
  })
  return uploaded.id
}

type UploadContext = {
  candidates: Candidate[]
  messages: Candidate[]
  claims: Candidate[]
  rows: Map<string, CandidateRow>
  roots: Map<number, MessageRow>
  hostedRoots: Map<number, string>
  client: RecordApiClient
  database: Database
  clock: () => number
  at: string
  skippedReceipts: number
  dropped: Set<string>
}

function stoppedAtRateCap(context: UploadContext): BoardAdoptionResult {
  const rows = ledger(context.database)
  const states = context.candidates
    .filter((row) => !context.dropped.has(candidateKey(row)))
    .map((row) => rows.get(`${row.kind}:${row.id}`)?.state ?? 'pending')
  const uploaded = states.filter((state) => state === 'uploaded').length
  const refused = states.filter((state) => state === 'refused').length
  const remaining = states.filter((state) => !isTerminalLedgerState(state)).length
  return {
    ...planFor(context.candidates, context.rows, rows, context.database),
    status: 'stopped',
    uploaded,
    refused,
    remaining,
    skippedReceipts: context.skippedReceipts,
    message: `hosted board post rate cap reached; ${remaining} rows remain; rerun the same command after the window to resume`,
  }
}

function unexpectedHostedRefusal(candidate: Candidate, error: unknown): Error | null {
  if (!(error instanceof RecordApiRequestError) || error.kind !== 'refused') return null
  const remedy =
    candidate.kind === 'claim'
      ? `release local claim ${candidate.id}`
      : `withdraw local ${candidate.kind} ${candidate.id}`
  return new Error(
    `hosted service refused local ${candidate.kind} ${candidate.id}: ${error.message}; ` +
      `${remedy} (or let it expire), then rerun orch board adopt with the new --confirm total`,
    { cause: error },
  )
}

async function uploadOneMessage(
  candidate: Candidate,
  context: UploadContext,
): Promise<'continue' | 'rate'> {
  return uploadOneCandidate(candidate, context, async (hostedId) =>
    uploadMessage(
      candidate,
      context.rows.get(candidateKey(candidate)) as MessageRow,
      hostedId,
      context.roots,
      context.hostedRoots,
      context.client,
      context.database,
    ),
  )
}

async function uploadMessages(context: UploadContext): Promise<BoardAdoptionResult | null> {
  for (const candidate of context.messages) {
    if ((await uploadOneMessage(candidate, context)) === 'rate') return stoppedAtRateCap(context)
  }
  for (const candidate of context.messages) {
    const recorded = ledger(context.database).get(`${candidate.kind}:${candidate.id}`)
    if (recorded?.state === 'uploaded')
      context.skippedReceipts += await uploadReceipts(
        candidate.id,
        recorded.hosted_id,
        context.client,
        context.database,
      )
  }
  return null
}

async function uploadOneClaim(
  candidate: Candidate,
  context: UploadContext,
): Promise<'continue' | 'rate'> {
  return uploadOneCandidate(candidate, context, (hostedId) =>
    uploadClaim(
      context.rows.get(candidateKey(candidate)) as ClaimRow,
      hostedId,
      context.clock,
      context.client,
      context.database,
    ),
  )
}

async function uploadOneCandidate(
  candidate: Candidate,
  context: UploadContext,
  writeHosted: (hostedId: string) => Promise<string | null>,
): Promise<'continue' | 'rate'> {
  const recorded = ledger(context.database).get(candidateKey(candidate))
  if (isTerminalLedgerState(recorded?.state)) {
    if (candidate.kind !== 'reply' && candidate.kind !== 'claim')
      context.hostedRoots.set(candidate.id, recorded!.hosted_id)
    return 'continue'
  }
  const pending = pendingLedger(candidate, context.at, context.database)
  const localRefusal = lastingLocalRefusal(
    candidate,
    context.rows.get(candidateKey(candidate))!,
    context.database,
  )
  if (localRefusal) {
    refuseCandidate(candidate, pending.hosted_id, localRefusal, context.at, context.database)
    return 'continue'
  }
  try {
    const hostedId = await writeHosted(pending.hosted_id)
    if (hostedId === null) return dropExpiredCandidate(candidate, context)
    retireCandidate(candidate, pending.hosted_id, hostedId, context.at, context.database)
    if (candidate.kind !== 'reply' && candidate.kind !== 'claim')
      context.hostedRoots.set(candidate.id, hostedId)
    return 'continue'
  } catch (error) {
    return handleUploadError(candidate, pending.hosted_id, error, context)
  }
}

function dropExpiredCandidate(candidate: Candidate, context: UploadContext): 'continue' {
  writeTransaction(() => {
    context.database
      .query(
        "DELETE FROM board_hosted_adoption_ledger WHERE local_kind=? AND local_id=? AND state='pending'",
      )
      .run(candidate.kind, candidate.id)
  }, context.database)
  context.dropped.add(candidateKey(candidate))
  return 'continue'
}

function handleUploadError(
  candidate: Candidate,
  hostedId: string,
  error: unknown,
  context: UploadContext,
): 'continue' | 'rate' {
  const disposition = uploadErrorDisposition(
    error instanceof RecordApiRequestError ? error.kind : 'unexpected',
    error instanceof Error ? error.message : String(error),
  )
  if (disposition === 'rate') return 'rate'
  if (disposition === 'machine')
    throw new Error(
      'this machine is not registered under the signed-in user; run orch sync on this machine, then rerun the same orch board adopt command',
      { cause: error },
    )
  if (disposition === 'lasting') {
    refuseCandidate(candidate, hostedId, (error as Error).message, context.at, context.database)
    return 'continue'
  }
  const refusal = unexpectedHostedRefusal(candidate, error)
  if (refusal) throw refusal
  throw error
}

async function uploadClaims(context: UploadContext): Promise<BoardAdoptionResult | null> {
  for (const candidate of context.claims)
    if ((await uploadOneClaim(candidate, context)) === 'rate') return stoppedAtRateCap(context)
  return null
}

export async function adoptHostedBoard(
  input: {
    confirm?: number
    clock?: () => number
    database?: Database
    client?: RecordApiClient
  } = {},
): Promise<BoardAdoptionResult> {
  const database = input.database ?? writableDb()
  if (boardHasAdoptedHosted(database))
    throw new Error('the local board is already adopted by the hosted board; no action was taken')
  const client = input.client ?? recordApiClient()
  await client.whoami()
  await client.listBoardChanges({ after: '0', limit: 1 })
  const clock = input.clock ?? Date.now
  const startedAt = clock()
  const at = new Date(startedAt).toISOString()
  const initialLedger = ledger(database)
  const gathered = candidateRows(startedAt, database, initialLedger)
  const { candidates, rows } = gathered
  const plan = planFor(candidates, rows, initialLedger, database)
  if (input.confirm === undefined)
    return {
      ...plan,
      status: 'plan',
      uploaded: 0,
      refused: 0,
      remaining: plan.total,
      skippedReceipts: 0,
    }
  if (input.confirm !== plan.total)
    throw new Error(
      `confirmation ${input.confirm} does not match current candidate total ${plan.total}; rerun orch board adopt --confirm ${plan.total}`,
    )

  const roots = new Map(messageRows(database).map((row) => [row.id, row]))
  const hostedRoots = new Map<number, string>()
  const messages = candidates.filter((candidate) => candidate.kind !== 'claim')
  const claims = candidates.filter((candidate) => candidate.kind === 'claim')
  const uploadContext: UploadContext = {
    candidates,
    messages,
    claims,
    rows,
    roots,
    hostedRoots,
    client,
    database,
    clock,
    at,
    skippedReceipts: 0,
    dropped: new Set(),
  }
  const stopped = await uploadMessages(uploadContext)
  if (stopped) return stopped
  const claimStopped = await uploadClaims(uploadContext)
  if (claimStopped) return claimStopped

  const finalRows = ledger(database)
  const completedCandidates = candidates.filter(
    (candidate) => !uploadContext.dropped.has(candidateKey(candidate)),
  )
  const states = completedCandidates.map(
    (row) => finalRows.get(`${row.kind}:${row.id}`)?.state ?? 'pending',
  )
  if (!mayMarkBoardHostedAdopted(states))
    throw new Error('hosted board adoption is incomplete; rerun the same command')
  writeTransaction(() => {
    database
      .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
      .run(BOARD_HOSTED_ADOPTED_KEY, '1')
  }, database)
  const refused = states.filter((state) => state === 'refused').length
  return {
    ...planFor(candidates, rows, finalRows, database),
    status: 'adopted',
    uploaded: states.length - refused,
    refused,
    remaining: 0,
    skippedReceipts: uploadContext.skippedReceipts,
  }
}
