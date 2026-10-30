// concern: hosted-board-read-cache
/** Refreshes the hosted read cache and narrows visible rows to this machine's readers. */
import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, SESSION_LIVE_MS, writableDb, writeTransaction } from '../database/db.ts'
import {
  type RecordApiClient,
  RecordApiRequestError,
  recordApiClient,
} from '../record/record-api-client.ts'
import {
  BOARD_CHANGES_PAGE_LIMIT,
  type HostedBoardChanges,
  type HostedBoardMessage,
} from '../record/record-board-contract.ts'
import { hostedBoardVerificationNoticeDecision } from './board-hosted-verification-policy.ts'
import { boardMode } from './board-mode.ts'
import {
  boardHeaderValue,
  messageCanBeReaped,
  messageIsLive,
  OPERATOR_READER,
  parseAudience,
} from './board-policy.ts'
import {
  type DeferredReplySuccessor,
  missingReaderStartWarning,
  replySuccessorAddressing,
  selectPushNotices,
} from './board-push-policy.ts'
import { renderBoardNotice, renderBoardNoticeOneLine } from './board-render.ts'
import * as replyAudience from './board-reply-audience.ts'
import { boardReaderBeganAt, originText, presenceFacts, recipients } from './board-store.ts'
import type { BoardTag } from './board-tags.ts'
import {
  renderBoardQuestion,
  renderBoardReply,
  renderBoardReplyDelivery,
} from './board-thread-render.ts'

export const BOARD_REFRESH_CURSOR_KEY = 'board_hosted_change_cursor'
const BOARD_REFRESH_AT_KEY = 'board_hosted_refresh_at'
export const BOARD_REFRESH_OUTCOME_KEY = 'board_hosted_refresh_outcome'
const BOARD_REFRESH_USER_KEY = 'board_hosted_signed_in_user'
export const BOARD_CACHE_OWNER_KEY = 'board_hosted_cache_owner'
const BOARD_VERIFIED_AT_KEY = 'board_hosted_verified_at'
const BOARD_MONITOR_UNVERIFIED_ANNOUNCED_KEY = 'board_hosted_monitor_unverified_announced'
export const BOARD_RECEIPT_WRITE_BUDGET_MS = 250
export const BOARD_READ_REFRESH_BUDGET_MS = 500
export const BOARD_VERIFICATION_WARNING_MAX_CHARS = 500

export type HostedCacheNotice = {
  id: string
  text: string
  oneLine: string
  ackRequired: boolean
  ackDeadline: string | null
  createdAt: string
  expiresAt: string | null
  purpose: import('../../../shared/board-purpose.ts').BoardPurpose
  reportReplySuccessor?: boolean
  threadTitle?: string
}

type RefreshInput = {
  budgetMs: number
  env?: Record<string, string | undefined>
  client?: RecordApiClient
  database?: Database
  now?: () => number
}

export type HostedBoardRefresh = {
  status: 'local' | 'success' | 'failed' | 'incomplete'
  applied: number
  reason?: string
}

const meta = (database: Database, key: string) =>
  (database.query('SELECT value FROM schema_meta WHERE key=?').get(key) as { value: string } | null)
    ?.value ?? null

function setMeta(database: Database, key: string, value: string): void {
  database
    .query(
      'INSERT INTO schema_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key, value)
}

function recordRefresh(database: Database, at: number, outcome: string): void {
  writeTransaction(() => {
    setMeta(database, BOARD_REFRESH_AT_KEY, new Date(at).toISOString())
    setMeta(database, BOARD_REFRESH_OUTCOME_KEY, outcome)
    if (outcome === 'success') setMeta(database, BOARD_VERIFIED_AT_KEY, new Date(at).toISOString())
  }, database)
}

async function within<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  remainingMs: number,
): Promise<T> {
  if (remainingMs <= 0) throw new Error('hosted board refresh budget spent')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(controller.signal).catch((error: unknown) => {
        if (controller.signal.aborted) throw new Error('hosted board refresh budget spent')
        throw error
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('hosted board refresh budget spent'))
        }, remainingMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function cachedRevision(database: Database, id: string): string | null {
  return (
    (
      database.query('SELECT revision FROM hosted_board_message_cache WHERE id=?').get(id) as {
        revision: string
      } | null
    )?.revision ?? null
  )
}

function incomingIsStale(cached: string | null, incoming: string): boolean {
  return cached !== null && BigInt(incoming) < BigInt(cached)
}

export function cacheHostedBoardReceipt(
  receipt: import('../record/record-board-contract.ts').HostedBoardReceipt,
  database: Database = writableDb(),
): void {
  database
    .query(
      `INSERT INTO hosted_board_receipt_cache
       (record_id,message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,pending_sync)
       SELECT ?,?,?,?,?,?,0 WHERE EXISTS (
         SELECT 1 FROM hosted_board_message_cache WHERE id=?
       ) ON CONFLICT(message_id,reader_session) DO UPDATE SET
       audience_at_posting=excluded.audience_at_posting,
       delivered_at=COALESCE(hosted_board_receipt_cache.delivered_at,excluded.delivered_at),
       acknowledged_at=COALESCE(hosted_board_receipt_cache.acknowledged_at,excluded.acknowledged_at),
       pending_sync=CASE WHEN hosted_board_receipt_cache.pending_sync=1 AND (
         (hosted_board_receipt_cache.delivered_at IS NOT NULL AND excluded.delivered_at IS NULL) OR
         (hosted_board_receipt_cache.acknowledged_at IS NOT NULL AND excluded.acknowledged_at IS NULL)
       ) THEN 1 ELSE 0 END,
       sync_error=NULL`,
    )
    .run(
      newRecordId(),
      receipt.messageId,
      receipt.readerSession,
      receipt.audienceAtPosting ? 1 : 0,
      receipt.deliveredAt,
      receipt.acknowledgedAt,
      receipt.messageId,
    )
}

export function queueHostedBoardAcknowledgement(
  messageId: string,
  readerSession: string,
  audienceAtPosting: boolean,
  acknowledgedAt: string,
  database: Database = writableDb(),
): void {
  const result = database
    .query(
      `INSERT INTO hosted_board_receipt_cache
       (record_id,message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,pending_sync)
       SELECT ?,?,?,?,?, ?,1 WHERE EXISTS (
         SELECT 1 FROM hosted_board_message_cache WHERE id=?
       ) ON CONFLICT(message_id,reader_session) DO UPDATE SET
       audience_at_posting=excluded.audience_at_posting,
       delivered_at=COALESCE(hosted_board_receipt_cache.delivered_at,excluded.delivered_at),
       acknowledged_at=COALESCE(hosted_board_receipt_cache.acknowledged_at,excluded.acknowledged_at),
       pending_sync=1,sync_error=NULL`,
    )
    .run(
      newRecordId(),
      messageId,
      readerSession,
      audienceAtPosting ? 1 : 0,
      acknowledgedAt,
      acknowledgedAt,
      messageId,
    )
  if (result.changes === 0)
    throw new Error(`hosted board notice ${messageId} is not cached; refresh the board and retry`)
}

function replacePage(database: Database, page: HostedBoardChanges): number {
  return writeTransaction(() => {
    const putMessage = database.query(
      `INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload)
       VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,
       thread_root_id=excluded.thread_root_id,revision=excluded.revision,payload=excluded.payload`,
    )
    const clearTags = database.query(
      'DELETE FROM hosted_board_message_tag_cache WHERE message_id=?',
    )
    const putTag = database.query(
      'INSERT INTO hosted_board_message_tag_cache(message_id,kind,value,origin) VALUES (?,?,?,?)',
    )
    let applied = 0
    for (const change of page.items) {
      const message = change.message
      if (incomingIsStale(cachedRevision(database, message.id), message.revision)) continue
      putMessage.run(
        message.id,
        message.kind,
        message.threadRootId,
        message.revision,
        JSON.stringify(message),
      )
      clearTags.run(message.id)
      for (const tag of change.tags) putTag.run(message.id, tag.kind, tag.value, tag.origin)
      for (const receipt of change.receipts) cacheHostedBoardReceipt(receipt, database)
      applied += 1
    }
    if (page.highestRevision !== null) advanceHostedBoardCursor(database, page.highestRevision)
    return applied
  }, database)
}

function advanceHostedBoardCursor(database: Database, highestRevision: string): void {
  const current = meta(database, BOARD_REFRESH_CURSOR_KEY)
  if (current === null || BigInt(highestRevision) > BigInt(current))
    setMeta(database, BOARD_REFRESH_CURSOR_KEY, highestRevision)
}

export function hostedBoardCursor(database: Database = db()): string {
  return meta(database, BOARD_REFRESH_CURSOR_KEY) ?? '0'
}

const CACHE_VERIFICATION_KEYS = [
  BOARD_REFRESH_CURSOR_KEY,
  BOARD_REFRESH_AT_KEY,
  BOARD_REFRESH_OUTCOME_KEY,
  BOARD_REFRESH_USER_KEY,
  BOARD_VERIFIED_AT_KEY,
  BOARD_MONITOR_UNVERIFIED_ANNOUNCED_KEY,
]

/** Returns true when a prior owner's cursor was discarded and revision zero must be fetched. */
function establishCacheOwner(database: Database, userId: string): boolean {
  if (!userId) {
    database.query('DELETE FROM schema_meta WHERE key=?').run(BOARD_REFRESH_USER_KEY)
    throw new Error('hosted board changes response did not identify its user')
  }
  const owner = meta(database, BOARD_CACHE_OWNER_KEY)
  const hasRows =
    (
      database.query('SELECT COUNT(*) count FROM hosted_board_message_cache').get() as {
        count: number
      }
    ).count > 0
  const reset = (owner !== null && owner !== userId) || (owner === null && hasRows)
  writeTransaction(() => {
    if (reset) {
      database.query('DELETE FROM hosted_board_message_cache').run()
      const clearMeta = database.query('DELETE FROM schema_meta WHERE key=?')
      for (const key of CACHE_VERIFICATION_KEYS) clearMeta.run(key)
    }
    setMeta(database, BOARD_CACHE_OWNER_KEY, userId)
    setMeta(database, BOARD_REFRESH_USER_KEY, userId)
  }, database)
  return reset
}

async function flushReceipts(
  client: RecordApiClient,
  database: Database,
  deadline: number,
  now: () => number,
): Promise<void> {
  const rows = database
    .query(
      `SELECT message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at
       FROM hosted_board_receipt_cache
       WHERE pending_sync=1 AND (delivered_at IS NOT NULL OR acknowledged_at IS NOT NULL)`,
    )
    .all() as {
    message_id: string
    reader_session: string
    audience_at_posting: number
    delivered_at: string | null
    acknowledged_at: string | null
  }[]
  for (const row of rows) {
    try {
      await within(
        (signal) =>
          client.putBoardReceipt(
            {
              messageId: row.message_id,
              readerSession: row.reader_session,
              audienceAtPosting: row.audience_at_posting === 1,
              delivered: row.delivered_at !== null,
              acknowledged: row.acknowledged_at !== null,
            },
            signal,
          ),
        deadline - now(),
      )
      database
        .query(
          `UPDATE hosted_board_receipt_cache SET pending_sync=0,sync_error=NULL
           WHERE message_id=? AND reader_session=?`,
        )
        .run(row.message_id, row.reader_session)
    } catch (error) {
      if (error instanceof RecordApiRequestError && error.kind === 'refused') {
        database
          .query(
            `UPDATE hosted_board_receipt_cache SET pending_sync=0,sync_error=?
             WHERE message_id=? AND reader_session=?`,
          )
          .run(error.message, row.message_id, row.reader_session)
        continue
      }
      return
    }
  }
}

function refreshFailure(
  database: Database,
  now: () => number,
  error: unknown,
  applied: number,
): HostedBoardRefresh {
  const reason = error instanceof Error ? error.message : String(error)
  recordRefresh(database, now(), `failed: ${reason}`)
  if (reason === 'hosted board refresh budget spent') {
    return { status: 'incomplete', applied }
  }
  return { status: 'failed', applied, reason }
}

async function fetchHostedPages(
  client: RecordApiClient,
  database: Database,
  deadline: number,
  now: () => number,
  tally: { applied: number },
): Promise<boolean> {
  let after = meta(database, BOARD_REFRESH_CURSOR_KEY) ?? '0'
  while (now() < deadline) {
    const query = { after, limit: BOARD_CHANGES_PAGE_LIMIT }
    const page = await within(
      (signal) => client.listBoardChanges({ ...query, signal }),
      deadline - now(),
    )
    if (establishCacheOwner(database, page.userId)) {
      after = '0'
      continue
    }
    tally.applied += replacePage(database, page)
    if (page.highestRevision !== null) after = page.highestRevision
    if (page.items.length >= BOARD_CHANGES_PAGE_LIMIT) continue
    await flushReceipts(client, database, deadline, now)
    return true
  }
  await flushReceipts(client, database, deadline, now)
  return false
}

export async function refreshHostedBoard(input: RefreshInput): Promise<HostedBoardRefresh> {
  const database = input.database ?? writableDb()
  const env = input.env ?? process.env
  const now = input.now ?? Date.now
  const deadline = now() + input.budgetMs
  try {
    if (boardMode('shared', env, database) === 'local') return { status: 'local', applied: 0 }
  } catch (error) {
    return refreshFailure(database, now, error, 0)
  }
  const tally = { applied: 0 }
  try {
    const caughtUp = await fetchHostedPages(
      input.client ?? recordApiClient(),
      database,
      deadline,
      now,
      tally,
    )
    recordRefresh(database, now(), 'success')
    return { status: caughtUp ? 'success' : 'incomplete', applied: tally.applied }
  } catch (error) {
    return refreshFailure(database, now, error, tally.applied)
  }
}

type CachedRow = { message: HostedBoardMessage; tags: BoardTag[] }

type HostedClaimFacts = {
  rootAuthorReceivedReply: boolean
  successorClaimed: boolean
}

function attachCachedTags<T extends { id: string; payload: string }>(
  database: Database,
  messages: T[],
): Array<CachedRow & Omit<T, 'id' | 'payload'>> {
  const tags = database
    .query('SELECT message_id,kind,value,origin FROM hosted_board_message_tag_cache ORDER BY rowid')
    .all() as Array<BoardTag & { message_id: string }>
  const tagsByMessage = new Map<string, BoardTag[]>()
  for (const { message_id: messageId, ...tag } of tags) {
    const existing = tagsByMessage.get(messageId)
    if (existing) existing.push(tag)
    else tagsByMessage.set(messageId, [tag])
  }
  return messages.map(({ id, payload, ...rest }) => ({
    ...rest,
    message: JSON.parse(payload) as HostedBoardMessage,
    tags: tagsByMessage.get(id) ?? [],
  }))
}

function loadCachedRows(database: Database): CachedRow[] {
  const messages = database
    .query('SELECT id,payload FROM hosted_board_message_cache ORDER BY rowid')
    .all() as { id: string; payload: string }[]
  return attachCachedTags(database, messages)
}

export function cachedRows(database: Database) {
  const owner = meta(database, BOARD_CACHE_OWNER_KEY)
  if (!owner || meta(database, BOARD_REFRESH_USER_KEY) !== owner) return []
  return loadCachedRows(database)
}

export function cachedHostedBoardMessages(database: Database = db()): HostedBoardMessage[] {
  return cachedRows(database).map((row) => row.message)
}

export const hostedMessageIsLive = (message: HostedBoardMessage, clock: number): boolean =>
  messageIsLive(
    {
      expiresAt: message.expiresAt ? Date.parse(message.expiresAt) : 0,
      withdrawnAt: message.withdrawnAt ? Date.parse(message.withdrawnAt) : null,
    },
    clock,
  )

type HostedClaimContext = {
  database: Database
  reader: string
  clock: number
  rows: CachedRow[]
  messages: HostedBoardMessage[]
  messagesById: Map<string, HostedBoardMessage>
  threadMessages: Map<string, HostedBoardMessage[]>
  presence: ReturnType<typeof presenceFacts>
  readerBeganAt: string | null
  readerRunId: string | null
  signedIn: string | null
  claimFacts: Map<string, HostedClaimFacts>
}

function claimContext(
  database: Database,
  reader: string,
  clock: number,
  rows: CachedRow[],
  signedIn: string | null,
  allRows: CachedRow[],
  claimFacts: Map<string, HostedClaimFacts>,
): HostedClaimContext {
  const messages = allRows.map((row) => row.message)
  const threadMessages = new Map<string, HostedBoardMessage[]>()
  for (const message of messages) {
    const threadId = message.threadRootId ?? message.id
    const thread = threadMessages.get(threadId)
    if (thread) thread.push(message)
    else threadMessages.set(threadId, [message])
  }
  return {
    database,
    reader,
    clock,
    rows,
    messages,
    messagesById: new Map(messages.map((message) => [message.id, message])),
    threadMessages,
    presence: presenceFacts(database, clock),
    readerBeganAt: reader === OPERATOR_READER ? null : boardReaderBeganAt(reader, database),
    readerRunId: readerRunId(reader, database),
    signedIn,
    claimFacts,
  }
}

// The one definition of "a different reader holds a successor claim for this reply".
// loadClaimContext's per-message successor_claimed fact and the transaction-time
// recheck in takeHostedReportReplySuccessor both interpolate this fragment, so the
// meaning of "claimed" cannot drift between the two sites. It correlates on the
// given message-id expression and binds the reader session as one ? parameter.
const successorClaimedByOther = (messageId: string) =>
  `EXISTS (
      SELECT 1 FROM hosted_board_receipt_cache successor_receipt
      WHERE successor_receipt.message_id=${messageId}
        AND successor_receipt.successor=1
        AND successor_receipt.reader_session<>?
    )`

function loadClaimContext(
  database: Database,
  reader: string,
  all: boolean,
  clock: number,
  extraRow?: CachedRow,
): HostedClaimContext {
  const owner = meta(database, BOARD_CACHE_OWNER_KEY)
  const signedIn = meta(database, BOARD_REFRESH_USER_KEY)
  if (!owner || owner !== signedIn) {
    const rows = extraRow ? [extraRow] : []
    return claimContext(database, reader, clock, rows, signedIn, rows, new Map())
  }
  const rows = attachCachedTags(
    database,
    database
      .query(
        `SELECT message.id,message.payload,receipt.delivered_at,receipt.acknowledged_at,
                ${successorClaimedByOther('message.id')} AS successor_claimed,
                EXISTS (
                  SELECT 1
                  FROM hosted_board_receipt_cache author_receipt
                  JOIN hosted_board_message_cache root
                    ON root.id=message.thread_root_id
                  WHERE author_receipt.message_id=message.id
                    AND author_receipt.reader_session=json_extract(root.payload,'$.authorSession')
                    AND author_receipt.delivered_at IS NOT NULL
                ) AS root_author_received_reply
       FROM hosted_board_message_cache message
       LEFT JOIN hosted_board_receipt_cache receipt
         ON receipt.message_id=message.id AND receipt.reader_session=?
       ORDER BY message.rowid`,
      )
      .all(reader, reader) as Array<{
      id: string
      payload: string
      delivered_at: string | null
      acknowledged_at: string | null
      successor_claimed: number
      root_author_received_reply: number
    }>,
  )
  const claimFacts = new Map(
    rows.map((row) => [
      row.message.id,
      {
        rootAuthorReceivedReply: Boolean(row.root_author_received_reply),
        successorClaimed: Boolean(row.successor_claimed),
      },
    ]),
  )
  const cached = rows.map(
    ({
      delivered_at: _delivered,
      acknowledged_at: _acknowledged,
      successor_claimed: _successor,
      root_author_received_reply: _author,
      ...row
    }) => row,
  )
  const allRows =
    extraRow && !cached.some((row) => row.message.id === extraRow.message.id)
      ? [...cached, extraRow]
      : cached
  const selected = rows
    .filter((row) => all || (!row.delivered_at && !row.acknowledged_at))
    .map(
      ({
        delivered_at: _delivered,
        acknowledged_at: _acknowledged,
        successor_claimed: _successor,
        root_author_received_reply: _author,
        ...row
      }) => row,
    )
  return claimContext(
    database,
    reader,
    clock,
    extraRow && !selected.some((row) => row.message.id === extraRow.message.id)
      ? [...selected, extraRow]
      : selected,
    signedIn,
    allRows,
    claimFacts,
  )
}

function readerRunId(reader: string, database: Database): string | null {
  const run = /^run:([0-9a-f-]{36})$/.exec(reader)
  if (!run) return null
  const root = database.query('SELECT record_id FROM run WHERE record_id=?').get(run[1]!) as {
    record_id: string | null
  } | null
  return root?.record_id ?? null
}

const readerMatchesAuthor = (message: HostedBoardMessage, context: HostedClaimContext) => {
  if (message.authorUserId !== context.signedIn) return false
  const { reader } = context
  if (reader === OPERATOR_READER) return message.authorSession === null
  if (!reader.startsWith('run:')) return message.authorSession === reader
  return Boolean(context.readerRunId && context.readerRunId === message.origin.runId)
}

const replyAddressesReader = (
  message: HostedBoardMessage,
  context: HostedClaimContext,
): boolean => {
  const rootId = message.threadRootId
  if (!rootId) return false
  const thread = context.threadMessages.get(rootId) ?? []
  const root = thread.find((candidate) => candidate.id === rootId)
  if (!root || !hostedMessageIsLive(root, context.clock)) return false
  const authorReader = (candidate: HostedBoardMessage): string =>
    candidate.authorUserId === context.signedIn
      ? (candidate.authorSession ?? OPERATOR_READER)
      : `user:${candidate.authorUserId}`
  const rootTags = context.rows.find((row) => row.message.id === rootId)?.tags ?? []
  const rootAudienceReaders = root.audience
    ? recipients(
        root.audience,
        context.clock,
        rootTags,
        context.database,
        context.presence,
        root.origin.project,
      )
    : []
  const cachedReceipts = context.database
    .query(`SELECT reader_session AS reader,audience_at_posting AS audienceAtPosting,
                   acknowledged_at AS acknowledged
            FROM hosted_board_receipt_cache WHERE message_id=? ORDER BY rowid`)
    .all(rootId) as Array<{
    reader: string
    audienceAtPosting: number
    acknowledged: string | null
  }>
  const receipts = replyAudience.mergeReplyAudienceReceipts(cachedReceipts, rootAudienceReaders)
  const earlierReplies = thread.filter(
    (candidate) =>
      candidate.kind === 'reply' &&
      (candidate.createdAt < message.createdAt ||
        (candidate.createdAt === message.createdAt && candidate.id < message.id)),
  )
  return replyAudience
    .resolveReplyReaders({
      rootAuthor: authorReader(root),
      threadAuthors: earlierReplies.map(authorReader),
      loopedInSessions: earlierReplies.flatMap((candidate) => {
        const session = replyAudience.loopedInSessionFromReplyAudience(candidate.audience)
        return session === null ? [] : [session]
      }),
      rootReceipts: receipts,
      audience: message.audience ? replyAudience.parseReplyAudienceOption(message.audience) : null,
      replier: authorReader(message),
    })
    .includes(context.reader)
}

function hostedReplySuccessorPush(
  message: HostedBoardMessage,
  context: HostedClaimContext,
): boolean {
  const rootId = message.threadRootId
  if (message.kind !== 'reply' || !rootId) return false
  const root = context.messagesById.get(rootId)
  if (!root?.authorSession || !root.origin.project) return false
  const facts = context.claimFacts.get(message.id)
  return replySuccessorAddressing({
    presence: context.presence,
    reader: context.reader,
    rootAuthorSession: root.authorSession,
    rootAuthorReceivedReply: facts?.rootAuthorReceivedReply ?? false,
    rootProject: root.origin.project,
    readerIsParticipant: replyAddressesReader(message, context),
    successorClaimed: facts?.successorClaimed ?? false,
    readerBeganAt: context.readerBeganAt,
    replyPostedAt: message.createdAt,
    now: context.clock,
    liveWindowMs: SESSION_LIVE_MS,
  })
}

function takeHostedReportReplySuccessor(
  message: HostedBoardMessage,
  context: HostedClaimContext,
): boolean {
  return writeTransaction(() => {
    // Transaction-time recheck through the same fragment loadClaimContext reads:
    // another reader may have claimed this reply since the claim context loaded.
    const recheck = context.database
      .query(`SELECT ${successorClaimedByOther('?')} AS successor_claimed`)
      .get(message.id, context.reader) as { successor_claimed: number }
    const successorClaimed = recheck.successor_claimed === 1
    if (successorClaimed) return false
    if (!hostedReplySuccessorPush(message, context)) return false
    context.database
      .query(
        `INSERT INTO hosted_board_receipt_cache
         (record_id,message_id,reader_session,audience_at_posting,successor,delivered_at,acknowledged_at,pending_sync)
         VALUES (?,?,?,0,1,NULL,NULL,1) ON CONFLICT(message_id,reader_session) DO UPDATE SET
         delivered_at=COALESCE(hosted_board_receipt_cache.delivered_at,excluded.delivered_at),
         successor=1,
         pending_sync=1`,
      )
      .run(newRecordId(), message.id, context.reader)
    return true
  }, context.database)
}

function messageAddressed(
  row: { message: HostedBoardMessage; tags: BoardTag[] },
  context: HostedClaimContext,
): boolean {
  const { message, tags } = row
  if (message.kind === 'reply')
    return replyAddressesReader(message, context) || hostedReplySuccessorPush(message, context)
  if (!message.audience || !hostedMessageIsLive(message, context.clock)) return false
  const audience = parseAudience(message.audience)
  if (
    (audience.kind === 'operator' || audience.kind === 'architects') &&
    message.authorUserId !== context.signedIn
  )
    return false
  if (
    audience.kind === 'architects' &&
    !audience.all &&
    !audience.value &&
    message.origin.projectStored === true &&
    message.origin.project === null
  )
    return false
  const addressed = recipients(
    message.audience,
    context.clock,
    tags,
    context.database,
    context.presence,
    message.origin.project,
  ).includes(context.reader)
  if (!addressed) return false
  if (message.kind === 'question' && context.reader.startsWith('run:')) return false
  return true
}

export function cachedMessageAddressed(
  row: { message: HostedBoardMessage; tags: BoardTag[] },
  reader: string,
  clock: number,
  database: Database,
): boolean {
  return messageAddressed(row, loadClaimContext(database, reader, true, clock, row))
}

export function hostedBoardVerificationWarning(database: Database = db()): string | null {
  const outcome = meta(database, BOARD_REFRESH_OUTCOME_KEY)
  if (!outcome?.startsWith('failed:')) return null
  const failedAt = boardHeaderValue(meta(database, BOARD_REFRESH_AT_KEY) ?? 'an unknown time')
  const verifiedAt = boardHeaderValue(meta(database, BOARD_VERIFIED_AT_KEY) ?? 'never')
  const reason = boardHeaderValue(outcome.slice('failed:'.length).trim() || 'unknown failure')
  const identity = meta(database, BOARD_REFRESH_USER_KEY) ? '' : '; identity is unverified'
  return boardHeaderValue(
    `Hosted board cache is unverified; last verified ${verifiedAt}; refresh failed at ${failedAt}: ${reason}${identity}.`,
  ).slice(0, BOARD_VERIFICATION_WARNING_MAX_CHARS)
}

export function takeHostedBoardVerificationTransition(
  database: Database = writableDb(),
  now = Date.now(),
): string | null {
  const warning = hostedBoardVerificationWarning(database)
  const currentlyUnverified = warning !== null
  const unverifiedNoticeAnnounced =
    meta(database, BOARD_MONITOR_UNVERIFIED_ANNOUNCED_KEY) === 'announced'
  const decision = hostedBoardVerificationNoticeDecision({
    currentlyUnverified,
    lastVerifiedAt: meta(database, BOARD_VERIFIED_AT_KEY),
    now,
    unverifiedNoticeAnnounced,
  })
  writeTransaction(() => {
    setMeta(
      database,
      BOARD_MONITOR_UNVERIFIED_ANNOUNCED_KEY,
      currentlyUnverified && (unverifiedNoticeAnnounced || decision === 'announce-unverified')
        ? 'announced'
        : 'unannounced',
    )
  }, database)
  if (decision === 'announce-unverified') return warning
  if (decision === 'announce-recovered')
    return `Hosted board cache is verified again at ${meta(database, BOARD_VERIFIED_AT_KEY) ?? 'an unknown time'}.`
  return null
}

function renderCached(
  message: HostedBoardMessage,
  tags: BoardTag[],
  rows: HostedBoardMessage[],
  worker: boolean,
): string {
  if (message.kind === 'reply') {
    const root = rows.find((candidate) => candidate.id === message.threadRootId)
    return renderBoardReply({
      id: message.id,
      origin: originText(message.origin),
      rootId: message.threadRootId ?? 'unknown',
      rootTitle: root?.title ?? '',
      audience: root?.audienceDescription,
      body: message.body,
    })
  }
  if (message.kind === 'question')
    return renderBoardQuestion({
      id: message.id,
      origin: originText(message.origin),
      title: message.title ?? '',
      audience: message.audienceDescription,
      body: message.body,
      expiresAt: message.expiresAt ?? '',
      tags: tags.filter((tag) => tag.origin === 'sender').map((tag) => `${tag.kind}:${tag.value}`),
    })
  return renderBoardNotice({
    id: message.id,
    kind: message.kind,
    purpose: message.purpose ?? 'information',
    authorKind: message.origin.kind,
    authorSession: message.authorSession,
    authorHarness: message.origin.harness,
    authorProject: message.origin.project,
    authorRunId: message.origin.runId,
    title: message.title ?? '',
    audience: message.audienceDescription,
    body: message.body,
    expiresAt: message.expiresAt ?? '',
    ackRequired: message.ackRequired,
    tags: tags.filter((tag) => tag.origin === 'sender'),
    worker,
  })
}

export function claimCachedHosted(
  reader: string,
  all = false,
  clock = Date.now(),
  database: Database = db(),
): HostedCacheNotice[] {
  return claimCachedHostedFromContext(loadClaimContext(database, reader, all, clock))
}

function claimCachedHostedFromContext(context: HostedClaimContext): HostedCacheNotice[] {
  return context.rows
    .filter((row) => !readerMatchesAuthor(row.message, context) && messageAddressed(row, context))
    .map(({ message, tags }) => {
      const notice = {
        id: message.id,
        text: renderCached(message, tags, context.messages, context.reader.startsWith('run:')),
        oneLine:
          message.kind === 'reply'
            ? renderBoardReplyDelivery({
                origin: originText(message.origin),
                rootId: message.threadRootId ?? 'unknown',
                rootTitle: context.messagesById.get(message.threadRootId ?? '')?.title ?? '',
                body: message.body,
              })
            : renderBoardNoticeOneLine({
                id: message.id,
                title: message.title ?? '',
                sender: originText(message.origin),
                ackRequired: message.ackRequired,
              }),
        ackRequired: message.ackRequired,
        ackDeadline: message.ackDeadline,
        createdAt: message.createdAt,
        expiresAt: message.expiresAt,
        purpose: message.purpose ?? 'information',
        ...(message.kind === 'reply'
          ? {
              threadTitle: context.messagesById.get(message.threadRootId ?? '')?.title ?? '',
            }
          : {}),
      }
      return message.kind === 'reply' && hostedReplySuccessorPush(message, context)
        ? { ...notice, reportReplySuccessor: true }
        : notice
    })
}

export function claimCachedHostedForPush(
  reader: string,
  all = false,
  clock = Date.now(),
  database: Database = writableDb(),
  claimReplySuccessors = true,
): {
  notices: HostedCacheNotice[]
  withheldOlderCount: number
  deferredReplySuccessors: DeferredReplySuccessor[]
  warning: string | null
} {
  const context = loadClaimContext(database, reader, all, clock)
  const beganAt = reader === OPERATOR_READER ? ('unbounded' as const) : context.readerBeganAt
  const selected = selectPushNotices(
    beganAt,
    claimCachedHostedFromContext(context),
    clock,
    claimReplySuccessors,
  )
  const notices = selected.notices.filter((notice) => {
    if (!notice.reportReplySuccessor) return true
    const message = context.messagesById.get(notice.id)
    return message !== undefined && takeHostedReportReplySuccessor(message, context)
  })
  return {
    notices,
    withheldOlderCount: selected.withheldOlderCount,
    deferredReplySuccessors: selected.deferredReplySuccessors.map((notice) => ({
      replyRecordId: notice.id,
      threadTitle: notice.threadTitle!,
    })),
    warning:
      reader !== OPERATOR_READER && beganAt === null ? missingReaderStartWarning(reader) : null,
  }
}

function audienceAtPosting(reader: string, createdAt: string, database: Database): boolean {
  if (reader === OPERATOR_READER) return true
  const beganAt = boardReaderBeganAt(reader, database)
  return beganAt !== null && beganAt <= createdAt
}

export function cachedAudienceAtPosting(
  messageId: string,
  reader: string,
  database: Database = db(),
): boolean | null {
  const row = database
    .query('SELECT payload FROM hosted_board_message_cache WHERE id=?')
    .get(messageId) as { payload: string } | null
  return row
    ? audienceAtPosting(reader, (JSON.parse(row.payload) as HostedBoardMessage).createdAt, database)
    : null
}

export async function markCachedHostedDelivered(
  reader: string,
  ids: string[],
  input: {
    client?: RecordApiClient
    database?: Database
    clock?: number
  } = {},
): Promise<void> {
  const database = input.database ?? writableDb()
  const at = new Date(input.clock ?? Date.now()).toISOString()
  const deadline = Date.now() + BOARD_RECEIPT_WRITE_BUDGET_MS
  const client = input.client ?? recordApiClient()
  for (const id of ids) {
    const row = database
      .query('SELECT payload FROM hosted_board_message_cache WHERE id=?')
      .get(id) as { payload: string } | null
    if (!row) continue
    const posting = audienceAtPosting(
      reader,
      (JSON.parse(row.payload) as HostedBoardMessage).createdAt,
      database,
    )
    writeTransaction(() => {
      database
        .query(
          `INSERT INTO hosted_board_receipt_cache(record_id,message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,pending_sync)
       VALUES (?,?,?,?,?,NULL,1) ON CONFLICT(message_id,reader_session) DO UPDATE SET
       delivered_at=COALESCE(hosted_board_receipt_cache.delivered_at,excluded.delivered_at),pending_sync=1`,
        )
        .run(newRecordId(), id, reader, posting ? 1 : 0, at)
    }, database)
    await syncCachedHostedReceipt(reader, id, posting, { client, database, deadline })
  }
}

export async function syncCachedHostedReceipt(
  reader: string,
  id: string,
  posting: boolean,
  input: {
    client?: RecordApiClient
    database?: Database
    deadline?: number
  } = {},
): Promise<void> {
  const database = input.database ?? writableDb()
  const client = input.client ?? recordApiClient()
  const deadline = input.deadline ?? Date.now() + BOARD_RECEIPT_WRITE_BUDGET_MS
  try {
    await within(
      (signal) =>
        client.putBoardReceipt(
          {
            messageId: id,
            readerSession: reader,
            audienceAtPosting: posting,
            delivered: true,
          },
          signal,
        ),
      deadline - Date.now(),
    )
    database
      .query(
        `UPDATE hosted_board_receipt_cache SET pending_sync=0,sync_error=NULL
           WHERE message_id=? AND reader_session=?`,
      )
      .run(id, reader)
  } catch {}
}

export function reapHostedBoardCache(
  clock = Date.now(),
  database: Database = writableDb(),
): number {
  const rows = loadCachedRows(database).map((row) => row.message)
  const acceptedRoots = new Set(
    rows.filter((row) => row.acceptedReplyId !== null).map((row) => row.id),
  )
  const removable = rows.filter((row) => {
    const rootId = row.threadRootId ?? row.id
    return (
      !acceptedRoots.has(rootId) &&
      row.expiresAt !== null &&
      messageCanBeReaped(
        {
          expiresAt: Date.parse(row.expiresAt),
          withdrawnAt: row.withdrawnAt ? Date.parse(row.withdrawnAt) : null,
        },
        clock,
      )
    )
  })
  const remove = database.query('DELETE FROM hosted_board_message_cache WHERE id=?')
  for (const row of removable) remove.run(row.id)
  return removable.length
}
