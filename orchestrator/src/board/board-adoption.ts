// concern: board-adoption
/** Plans and performs the one-time, resumable move from the local board to the hosted board. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { writableDb, writeTransaction } from '../database/db.ts'
import { projectRowByName } from '../project/projects.ts'
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
import { OPERATOR_READER, parseAudience } from './board-policy.ts'
import { parseReplyAudienceOption } from './board-reply-audience.ts'
import {
  latestRunStatus,
  type MessageRow,
  messageRows,
  messageTags,
  presenceFacts,
  recipients,
  rowIsLive,
} from './board-store.ts'

type LedgerRow = {
  local_kind: LocalKind
  source_record_id: string
  state: LedgerState
  refusal: string | null
}

type BoardAdoptionPlan = {
  total: number
  counts: Record<LocalKind, number>
  receipts: number
  stays: Array<{ kind: LocalKind; recordId: string; reason: string }>
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
          `SELECT ledger.local_kind,ledger.source_record_id,ledger.state,ledger.refusal
           FROM board_hosted_adoption_ledger ledger
           LEFT JOIN board_claim claim
             ON ledger.local_kind='claim' AND claim.record_id=ledger.source_record_id
           LEFT JOIN board_message message
             ON ledger.local_kind<>'claim' AND message.record_id=ledger.source_record_id`,
        )
        .all() as LedgerRow[]
    ).map((row) => [`${row.local_kind}:${row.source_record_id}`, row]),
  )
}

type ClaimRow = {
  record_id: string
  project: string
  subject_kind: 'task' | 'path' | 'resource'
  subject_value: string
  holder_session: string | null
  note: string | null
  run_record_id: string | null
  lapses_at: string
  closed_at: string | null
}

type CandidateRow = MessageRow | ClaimRow
const candidateKey = (candidate: Candidate) => `${candidate.kind}:${candidate.recordId}`

function candidateRows(
  clock: number,
  database: Database,
  recorded: Map<string, LedgerRow>,
): { candidates: Candidate[]; rows: Map<string, CandidateRow> } {
  const messages = messageRows(database)
  const byId = new Map(messages.map((row) => [row.record_id, row]))
  const rows = new Map<string, CandidateRow>()
  const messageFacts = messages.flatMap((row): CandidateFact[] => {
    if (row.kind !== 'notice' && row.kind !== 'question' && row.kind !== 'reply') return []
    const root = row.kind === 'reply' ? byId.get(row.thread_root_record_id!) : row
    const prior = recorded.get(`${row.kind}:${row.record_id}`)
    const movedRoot = root && recorded.get(`${root.kind}:${root.record_id}`)?.state === 'uploaded'
    const live =
      row.kind === 'reply' && movedRoot
        ? rowIsLive({ ...root, withdrawn_at: null }, clock, database)
        : rowIsLive(row, clock, database)
    if (!root?.audience) return []
    return [
      {
        candidate: { kind: row.kind, recordId: row.record_id, createdAt: row.created_at },
        live,
        accepted: root.accepted_reply_record_id !== null,
        machine: parseAudience(root.audience).kind === 'machine',
        recorded: isTerminalLedgerState(prior?.state),
      },
    ]
  })
  const claims = database
    .query(
      'SELECT record_id,project,subject_kind,subject_value,holder_session,note,run_record_id,lapses_at,closed_at FROM board_claim',
    )
    .all() as ClaimRow[]
  const claimFacts = claims.map(
    (row): CandidateFact => ({
      candidate: { kind: 'claim', recordId: row.record_id, createdAt: row.lapses_at },
      recorded: isTerminalLedgerState(recorded.get(`claim:${row.record_id}`)?.state),
      live: claimIsLive({
        closed: row.closed_at !== null,
        lapsesAt: Date.parse(row.lapses_at),
        runStatus: latestRunStatus(row.run_record_id, database),
        now: clock,
      }),
      accepted: false,
      machine: false,
    }),
  )
  for (const row of messages) rows.set(`${row.kind}:${row.record_id}`, row)
  for (const row of claims) rows.set(`claim:${row.record_id}`, row)
  return { candidates: selectBoardAdoptionCandidates([...messageFacts, ...claimFacts]), rows }
}

function lastingLocalRefusal(
  candidate: Candidate,
  row: CandidateRow,
  database: Database,
): string | null {
  if (candidate.kind === 'reply') {
    const message = row as MessageRow
    const root = database
      .query<{ kind: LocalKind }, [string]>('SELECT kind FROM board_message WHERE record_id=?')
      .get(message.thread_root_record_id!)
    const rootLedger = root
      ? ledger(database).get(`${root.kind}:${message.thread_root_record_id}`)
      : undefined
    if (rootLedger?.state === 'refused')
      return `thread root ${message.thread_root_record_id} was refused by the hosted service: ${rootLedger.refusal}`
  }
  return null
}

function planFor(
  candidates: Candidate[],
  localRows: Map<string, CandidateRow>,
  rows: Map<string, LedgerRow>,
  database: Database,
  clock: number,
) {
  const counts = emptyCounts()
  const stays: BoardAdoptionPlan['stays'] = []
  const receiptCandidates: Candidate[] = []
  for (const candidate of candidates) {
    const recorded = rows.get(`${candidate.kind}:${candidate.recordId}`)
    const reason =
      recorded?.state === 'refused'
        ? recorded.refusal
        : lastingLocalRefusal(candidate, localRows.get(candidateKey(candidate))!, database)
    if (reason) stays.push({ kind: candidate.kind, recordId: candidate.recordId, reason })
    else {
      counts[candidate.kind]++
      receiptCandidates.push(candidate)
    }
  }
  return {
    total: candidates.length,
    counts,
    receipts: pendingReceipts(receiptCandidates, database, clock).length,
    stays,
    note: 'Uploaded rows take the upload time as their creation time; absolute expiry is preserved. Hosted reach counts readers from adoption onward.',
  } satisfies BoardAdoptionPlan
}

function pendingLedger(
  candidate: Candidate,
  sourceRecordId: string,
  at: string,
  database: Database,
): LedgerRow {
  return writeTransaction(() => {
    database
      .query(
        `INSERT OR IGNORE INTO board_hosted_adoption_ledger
         (source_record_id,local_kind,state,refusal,created_at,updated_at)
         VALUES (?,?,'pending',NULL,?,?)`,
      )
      .run(sourceRecordId, candidate.kind, at, at)
    return database
      .query<LedgerRow, [string]>(
        `SELECT local_kind,source_record_id,state,refusal
         FROM board_hosted_adoption_ledger WHERE source_record_id=?`,
      )
      .get(sourceRecordId)!
  }, database)
}

function refuseCandidate(sourceRecordId: string, reason: string, at: string, database: Database) {
  writeTransaction(() => {
    database
      .query(
        `UPDATE board_hosted_adoption_ledger SET state='refused',refusal=?,updated_at=?
         WHERE source_record_id=?`,
      )
      .run(reason, at, sourceRecordId)
  }, database)
}

function retireCandidate(
  candidate: Candidate,
  sourceRecordId: string,
  at: string,
  database: Database,
) {
  writeTransaction(() => {
    database
      .query(
        `UPDATE board_hosted_adoption_ledger
         SET state='uploaded',refusal=NULL,updated_at=?
         WHERE source_record_id=?`,
      )
      .run(at, sourceRecordId)
    if (candidate.kind === 'claim')
      database
        .query(
          "UPDATE board_claim SET closed_at=?,close_reason='released' WHERE record_id=? AND closed_at IS NULL",
        )
        .run(at, candidate.recordId)
    else
      database
        .query(
          "UPDATE board_message SET withdrawn_at=?,withdrawn_reason='adopted' WHERE record_id=? AND withdrawn_at IS NULL",
        )
        .run(at, candidate.recordId)
  }, database)
}

function originalProject(row: MessageRow, root: MessageRow | undefined): string | undefined {
  return row.author_project ?? root?.author_project ?? undefined
}

async function uploadMessage(
  candidate: Candidate,
  row: MessageRow,
  hostedId: string,
  roots: Map<string, MessageRow>,
  hostedRoots: Map<string, string>,
  client: RecordApiClient,
  database: Database,
): Promise<string> {
  const authorRunId = row.author_run_record_id
  if (candidate.kind === 'reply') {
    const rootId = row.thread_root_record_id!
    const hostedRoot = hostedRoots.get(rootId)
    if (!hostedRoot) throw new Error(`local reply ${row.number} has no uploaded root ${rootId}`)
    const project = row.author_project ?? undefined
    const projectId = project ? (projectRowByName(project, database)?.recordId ?? null) : null
    const uploaded = await client.replyBoardMessage(hostedRoot, {
      id: hostedId,
      body: row.body,
      ...(row.audience === null ? {} : { audience: parseReplyAudienceOption(row.audience) }),
      authorSession: row.author_session,
      authorHarness: row.author_harness,
      authorMachineId: machineId(),
      authorRunId,
      project,
      projectId,
    })
    return uploaded.id
  }
  if (candidate.kind === 'claim')
    throw new Error(`claim ${candidate.recordId} is not a board message`)
  const tags = messageTags(row.record_id, database).filter((tag) => tag.origin === 'sender')
  const project = originalProject(
    row,
    row.thread_root_record_id ? roots.get(row.thread_root_record_id) : undefined,
  )
  const projectId = project ? (projectRowByName(project, database)?.recordId ?? null) : null
  const uploaded = await client.postBoardMessage({
    id: hostedId,
    kind: candidate.kind,
    purpose: row.purpose ?? (candidate.kind === 'question' ? 'request' : 'information'),
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
    project,
    projectId,
  })
  return uploaded.id
}

async function uploadReceipts(
  messageId: string,
  hostedId: string,
  client: RecordApiClient,
  database: Database,
  clock: number,
): Promise<number> {
  let skipped = 0
  const receipts = pendingReceiptsForMessage(messageId, database, clock)
  for (const receipt of receipts) {
    try {
      await client.putBoardReceipt({
        messageId: hostedId,
        readerSession: receipt.reader_session,
        audienceAtPosting: receipt.audience_at_posting === 1,
        delivered: Boolean(receipt.delivered_at),
        acknowledged: Boolean(receipt.acknowledged_at),
      })
      recordReceiptUpload(hostedId, receipt.reader_session, 'uploaded', null, database, clock)
    } catch (error) {
      if (!(error instanceof RecordApiRequestError) || error.kind !== 'refused') throw error
      recordReceiptUpload(
        hostedId,
        receipt.reader_session,
        'skipped',
        error.message,
        database,
        clock,
      )
      skipped++
    }
  }
  return skipped
}

type LocalReceipt = {
  message_record_id: string
  reader_session: string
  audience_at_posting: number
  delivered_at: string | null
  acknowledged_at: string | null
}

function pendingReceipts(
  candidates: Candidate[],
  database: Database,
  clock: number,
): LocalReceipt[] {
  return candidates
    .filter((candidate) => candidate.kind !== 'claim')
    .flatMap((candidate) => pendingReceiptsForMessage(candidate.recordId, database, clock))
}

function pendingReceiptsForMessage(
  messageRecordId: string,
  database: Database,
  clock: number,
): LocalReceipt[] {
  const facts = presenceFacts(database, clock)
  const receipts = database
    .query(
      `SELECT r.message_record_id,r.reader_session,r.audience_at_posting,r.delivered_at,r.acknowledged_at
       FROM board_receipt r
       JOIN board_message message ON message.record_id=r.message_record_id
       LEFT JOIN board_hosted_adoption_receipt a
         ON a.message_record_id=message.record_id AND a.reader_session=r.reader_session
       WHERE r.message_record_id=? AND a.message_record_id IS NULL
       ORDER BY r.reader_session`,
    )
    .all(messageRecordId) as LocalReceipt[]
  return receipts.filter(
    (receipt) =>
      (receipt.delivered_at !== null || receipt.acknowledged_at !== null) &&
      (receipt.reader_session === OPERATOR_READER ||
        recipients(
          receipt.reader_session.startsWith('run:')
            ? receipt.reader_session
            : `session:${receipt.reader_session}`,
          clock,
          [],
          database,
          facts,
        ).includes(receipt.reader_session)),
  )
}

function recordReceiptUpload(
  messageRecordId: string,
  readerSession: string,
  state: 'uploaded' | 'skipped',
  refusal: string | null,
  database: Database,
  clock: number,
): void {
  writeTransaction(() => {
    database
      .query(
        `INSERT INTO board_hosted_adoption_receipt
         (message_record_id,reader_session,state,refusal,updated_at) VALUES (?,?,?,?,?)`,
      )
      .run(messageRecordId, readerSession, state, refusal, new Date(clock).toISOString())
  }, database)
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
    projectId: projectRowByName(row.project, database)!.recordId,
    subject: `${row.subject_kind}:${row.subject_value}`,
    durationMs: remaining,
    runId: row.run_record_id,
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
  roots: Map<string, MessageRow>
  hostedRoots: Map<string, string>
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
    .map((row) => rows.get(`${row.kind}:${row.recordId}`)?.state ?? 'pending')
  const uploaded = states.filter((state) => state === 'uploaded').length
  const refused = states.filter((state) => state === 'refused').length
  const remaining = states.filter((state) => !isTerminalLedgerState(state)).length
  return {
    ...planFor(context.candidates, context.rows, rows, context.database, context.clock()),
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
      ? `release local claim ${candidate.recordId}`
      : `withdraw local ${candidate.kind} ${candidate.recordId}`
  return new Error(
    `hosted service refused local ${candidate.kind} ${candidate.recordId}: ${error.message}; ` +
      `${remedy} (or let it expire), then rerun ${PLATFORM_SLUG} board adopt with the new --confirm total`,
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
    const recorded = ledger(context.database).get(`${candidate.kind}:${candidate.recordId}`)
    if (recorded?.state === 'uploaded')
      context.skippedReceipts += await uploadReceipts(
        candidate.recordId,
        recorded.source_record_id,
        context.client,
        context.database,
        context.clock(),
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
      context.hostedRoots.set(candidate.recordId, recorded!.source_record_id)
    return 'continue'
  }
  const row = context.rows.get(candidateKey(candidate))!
  const pending = pendingLedger(
    candidate,
    recorded?.source_record_id ?? row.record_id,
    context.at,
    context.database,
  )
  const localRefusal = lastingLocalRefusal(candidate, row, context.database)
  if (localRefusal) {
    refuseCandidate(pending.source_record_id, localRefusal, context.at, context.database)
    return 'continue'
  }
  try {
    const hostedId = await writeHosted(pending.source_record_id)
    if (hostedId === null) return dropExpiredCandidate(candidate, context)
    retireCandidate(candidate, pending.source_record_id, context.at, context.database)
    if (candidate.kind !== 'reply' && candidate.kind !== 'claim')
      context.hostedRoots.set(candidate.recordId, pending.source_record_id)
    return 'continue'
  } catch (error) {
    return handleUploadError(candidate, pending.source_record_id, error, context)
  }
}

function dropExpiredCandidate(candidate: Candidate, context: UploadContext): 'continue' {
  writeTransaction(() => {
    context.database
      .query(
        "DELETE FROM board_hosted_adoption_ledger WHERE source_record_id=? AND state='pending'",
      )
      .run(context.rows.get(candidateKey(candidate))!.record_id)
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
      `this machine is not registered under the signed-in user; run ${PLATFORM_SLUG} record sync on this machine, then rerun the same ${PLATFORM_SLUG} board adopt command`,
      { cause: error },
    )
  if (disposition === 'lasting') {
    refuseCandidate(hostedId, (error as Error).message, context.at, context.database)
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
  try {
    await client.listBoardChanges({ after: '0', limit: 1 })
  } catch (error) {
    if (error instanceof RecordApiRequestError && error.kind === 'refused') {
      const serviceMessage = error.message.split(/\r?\n/, 1)[0]
      throw new Error(
        `the deployed record API did not serve the board routes: ${serviceMessage}; deploy the record API from a commit that includes the board routes, then rerun ${PLATFORM_SLUG} board adopt`,
        { cause: error },
      )
    }
    throw error
  }
  const clock = input.clock ?? Date.now
  const startedAt = clock()
  const at = new Date(startedAt).toISOString()
  const initialLedger = ledger(database)
  const gathered = candidateRows(startedAt, database, initialLedger)
  const { candidates, rows } = gathered
  const plan = planFor(candidates, rows, initialLedger, database, startedAt)
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
      `confirmation ${input.confirm} does not match current candidate total ${plan.total}; rerun ${PLATFORM_SLUG} board adopt --confirm ${plan.total}`,
    )

  const roots = new Map(messageRows(database).map((row) => [row.record_id, row]))
  const hostedRoots = new Map<string, string>()
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
    (row) => finalRows.get(`${row.kind}:${row.recordId}`)?.state ?? 'pending',
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
    ...planFor(candidates, rows, finalRows, database, clock()),
    status: 'adopted',
    uploaded: states.length - refused,
    refused,
    remaining: 0,
    skippedReceipts: uploadContext.skippedReceipts,
  }
}
