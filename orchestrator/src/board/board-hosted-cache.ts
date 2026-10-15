// concern: hosted-board-read-cache
/** Refreshes the hosted read cache and narrows visible rows to this machine's readers. */
import type { Database } from 'bun:sqlite'
import { db, writableDb, writeTransaction } from '../database/db.ts'
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
import { boardMode } from './board-mode.ts'
import {
  messageCanBeReaped,
  messageIsLive,
  OPERATOR_READER,
  parseAudience,
} from './board-policy.ts'
import { missingReaderStartWarning, selectPushNotices } from './board-push-policy.ts'
import { boardHeaderValue, renderBoardNotice, renderBoardNoticeOneLine } from './board-render.ts'
import { boardReaderBeganAt, originText, presenceFacts, recipients } from './board-store.ts'
import type { BoardTag } from './board-tags.ts'
import { renderBoardQuestion, renderBoardReply } from './board-thread-render.ts'

export const BOARD_REFRESH_CURSOR_KEY = 'board_hosted_change_cursor'
const BOARD_REFRESH_AT_KEY = 'board_hosted_refresh_at'
export const BOARD_REFRESH_OUTCOME_KEY = 'board_hosted_refresh_outcome'
const BOARD_REFRESH_USER_KEY = 'board_hosted_signed_in_user'
export const BOARD_CACHE_OWNER_KEY = 'board_hosted_cache_owner'
const BOARD_VERIFIED_AT_KEY = 'board_hosted_verified_at'
const BOARD_MONITOR_VERIFICATION_KEY = 'board_hosted_monitor_verification'
export const BOARD_RECEIPT_WRITE_BUDGET_MS = 250
export const BOARD_VERIFICATION_WARNING_MAX_CHARS = 500

export type HostedCacheNotice = {
  id: string
  text: string
  oneLine: string
  ackRequired: boolean
  createdAt: string
  purpose: import('../../../shared/board-purpose.ts').BoardPurpose
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
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,pending_sync)
       SELECT ?,?,?,?,?,0 WHERE EXISTS (
         SELECT 1 FROM hosted_board_message_cache WHERE id=?
       ) ON CONFLICT(message_id,reader_session) DO UPDATE SET
       audience_at_posting=excluded.audience_at_posting,
       delivered_at=COALESCE(hosted_board_receipt_cache.delivered_at,excluded.delivered_at),
       acknowledged_at=COALESCE(hosted_board_receipt_cache.acknowledged_at,excluded.acknowledged_at),
       pending_sync=0,sync_error=NULL`,
    )
    .run(
      receipt.messageId,
      receipt.readerSession,
      receipt.audienceAtPosting ? 1 : 0,
      receipt.deliveredAt,
      receipt.acknowledgedAt,
      receipt.messageId,
    )
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
  BOARD_MONITOR_VERIFICATION_KEY,
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
      `SELECT message_id,reader_session,audience_at_posting FROM hosted_board_receipt_cache
       WHERE pending_sync=1 AND delivered_at IS NOT NULL`,
    )
    .all() as { message_id: string; reader_session: string; audience_at_posting: number }[]
  for (const row of rows) {
    try {
      await within(
        (signal) =>
          client.putBoardReceipt(
            {
              messageId: row.message_id,
              readerSession: row.reader_session,
              audienceAtPosting: row.audience_at_posting === 1,
              delivered: true,
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

async function withinPage(
  client: RecordApiClient,
  query: { after: string; limit: number },
  remainingMs: number,
): Promise<HostedBoardChanges> {
  if (remainingMs <= 0) throw new Error('hosted board refresh budget spent')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const operation = client.listBoardChanges({ ...query, signal: controller.signal })
  try {
    return await Promise.race([
      operation.catch((error: unknown) => {
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

async function fetchHostedPages(
  client: RecordApiClient,
  database: Database,
  deadline: number,
  now: () => number,
  tally: { applied: number },
): Promise<boolean> {
  let after = meta(database, BOARD_REFRESH_CURSOR_KEY) ?? '0'
  while (now() < deadline) {
    const page = await withinPage(
      client,
      { after, limit: BOARD_CHANGES_PAGE_LIMIT },
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

function loadCachedRows(
  database: Database,
): Array<{ message: HostedBoardMessage; tags: BoardTag[] }> {
  return (
    database.query('SELECT id,payload FROM hosted_board_message_cache').all() as {
      id: string
      payload: string
    }[]
  ).map((row) => ({
    message: JSON.parse(row.payload) as HostedBoardMessage,
    tags: database
      .query(
        'SELECT kind,value,origin FROM hosted_board_message_tag_cache WHERE message_id=? ORDER BY rowid',
      )
      .all(row.id) as BoardTag[],
  }))
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

const readerMatchesAuthor = (message: HostedBoardMessage, reader: string, database: Database) => {
  if (message.authorUserId !== meta(database, BOARD_REFRESH_USER_KEY)) return false
  if (reader === OPERATOR_READER) return message.authorSession === null
  const run = /^run:(\d+)$/.exec(reader)
  if (!run) return message.authorSession === reader
  const root = database.query('SELECT record_id FROM run WHERE id=?').get(Number(run[1])) as {
    record_id: string | null
  } | null
  return Boolean(root?.record_id && root.record_id === message.origin.runId)
}

const replyAddressesReader = (
  message: HostedBoardMessage,
  reader: string,
  clock: number,
  database: Database,
): boolean => {
  const rootId = message.threadRootId
  if (!rootId) return false
  const thread = cachedRows(database)
    .map((item) => item.message)
    .filter((candidate) => candidate.id === rootId || candidate.threadRootId === rootId)
  const root = thread.find((candidate) => candidate.id === rootId)
  if (!root || !hostedMessageIsLive(root, clock)) return false
  return thread.some(
    (candidate) =>
      candidate.createdAt < message.createdAt && readerMatchesAuthor(candidate, reader, database),
  )
}

export function cachedMessageAddressed(
  row: { message: HostedBoardMessage; tags: BoardTag[] },
  reader: string,
  clock: number,
  database: Database,
): boolean {
  const { message, tags } = row
  if (message.kind === 'reply') return replyAddressesReader(message, reader, clock, database)
  if (!message.audience || !hostedMessageIsLive(message, clock)) return false
  const audience = parseAudience(message.audience)
  const signedIn = meta(database, BOARD_REFRESH_USER_KEY)
  if (
    (audience.kind === 'operator' || audience.kind === 'architects') &&
    message.authorUserId !== signedIn
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
    clock,
    tags,
    database,
    presenceFacts(database, clock),
    message.origin.project,
  ).includes(reader)
  if (!addressed) return false
  if (message.kind === 'question' && reader.startsWith('run:')) return false
  return true
}

function delivered(database: Database, id: string, reader: string): boolean {
  const receipt = database
    .query(
      'SELECT delivered_at,acknowledged_at FROM hosted_board_receipt_cache WHERE message_id=? AND reader_session=?',
    )
    .get(id, reader) as {
    delivered_at: string | null
    acknowledged_at: string | null
  } | null
  return Boolean(receipt?.delivered_at || receipt?.acknowledged_at)
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
): string | null {
  const warning = hostedBoardVerificationWarning(database)
  const current = warning ? 'failed' : 'verified'
  const previous = meta(database, BOARD_MONITOR_VERIFICATION_KEY)
  setMeta(database, BOARD_MONITOR_VERIFICATION_KEY, current)
  if (warning && previous !== 'failed') return warning
  if (!warning && previous === 'failed')
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
  const rows = cachedRows(database)
  const messages = rows.map((row) => row.message)
  return rows
    .filter(
      (row) =>
        !readerMatchesAuthor(row.message, reader, database) &&
        cachedMessageAddressed(row, reader, clock, database) &&
        (all || !delivered(database, row.message.id, reader)),
    )
    .map(({ message, tags }) => ({
      id: message.id,
      text: renderCached(message, tags, messages, reader.startsWith('run:')),
      oneLine: renderBoardNoticeOneLine({
        id: message.id,
        title:
          message.kind === 'reply'
            ? (messages.find((candidate) => candidate.id === message.threadRootId)?.title ?? '')
            : (message.title ?? ''),
        sender: originText(message.origin),
        ackRequired: message.ackRequired,
      }),
      ackRequired: message.ackRequired,
      createdAt: message.createdAt,
      purpose: message.purpose ?? 'information',
    }))
}

export function claimCachedHostedForPush(
  reader: string,
  all = false,
  clock = Date.now(),
  database: Database = db(),
): { notices: HostedCacheNotice[]; withheldOlderCount: number; warning: string | null } {
  const beganAt = reader === OPERATOR_READER ? null : boardReaderBeganAt(reader, database)
  return {
    ...selectPushNotices(beganAt, claimCachedHosted(reader, all, clock, database)),
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
          `INSERT INTO hosted_board_receipt_cache(message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,pending_sync)
       VALUES (?,?,?,?,NULL,1) ON CONFLICT(message_id,reader_session) DO UPDATE SET
       delivered_at=COALESCE(hosted_board_receipt_cache.delivered_at,excluded.delivered_at),pending_sync=1`,
        )
        .run(id, reader, posting ? 1 : 0, at)
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
