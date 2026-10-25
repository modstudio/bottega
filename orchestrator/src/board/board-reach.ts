// concern: board-reach-measurement
/** Records push facts and turns them into the board noise decision surface. */

import type { Database } from 'bun:sqlite'
import { type BoardPurpose, parseBoardPurpose } from '../../../shared/board-purpose.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { projects } from '../project/projects.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import { cachedHostedBoardMessages } from './board-hosted-cache.ts'
import { type Audience, parseAudience } from './board-policy.ts'
import { BOARD_MESSAGE_COLUMNS, type MessageRow } from './board-store.ts'

export const BOARD_REACH_DEFAULT_HOURS = 24
export const BOARD_REACH_MAX_HOURS = 7 * 24
export const BOARD_REACH_RETENTION_HOURS = 30 * 24

const BOARD_REACH_DELIVERY_COLUMNS =
  'record_id,message_source,message_record_id,reader_session,reader_project,delivery_point,blocked_stop,audience,acknowledgement_required,purpose,posted_at,expires_at,session_started_at,posting_timing,concern,recorded_at'

export type BoardDeliveryPoint = 'session-start' | 'after-tool-call' | 'stop' | 'heartbeat-monitor'
type BoardReachConcern = 'concerned' | 'not-concerned' | 'unqualified'

export type BoardReachRow = {
  recordId: string
  messageSource: 'local' | 'hosted'
  messageId: string
  readerSession: string
  readerProject: string
  deliveryPoint: BoardDeliveryPoint
  blockedStop: boolean
  audience: string
  acknowledgementRequired: boolean
  purpose?: BoardPurpose
  postedAt: string
  expiresAt: string | null
  sessionStartedAt: string
  postingTiming: 'before-session' | 'after-session'
  concern: BoardReachConcern
  recordedAt: string
  audienceAtPosting: boolean | null
  successor: boolean
}

export type BoardReachRecordingInput = {
  emissionId: string
  session: string
  messageSource: 'local' | 'hosted'
  messageId: string
  deliveryPoint: BoardDeliveryPoint
  blockedStop: boolean
  recordedAt: string
}

export type BoardReplyReachRow = {
  messageSource: 'local' | 'hosted'
  replyId: string
  title: string | null
  createdAt: string
  rootAuthorDeliveredAt: string | null
  successorDeliveredAt: string | null
  firstDeliveredAt: string | null
}

export function countBoardReplyReach(rows: BoardReplyReachRow[]) {
  const deliveredLatencies = rows.flatMap((row) =>
    row.firstDeliveredAt === null
      ? []
      : [Math.max(0, Date.parse(row.firstDeliveredAt) - Date.parse(row.createdAt))],
  )
  deliveredLatencies.sort((left, right) => left - right)
  const middle = Math.floor(deliveredLatencies.length / 2)
  const medianFirstDeliveryLatencyMs = deliveredLatencies.length
    ? deliveredLatencies.length % 2
      ? deliveredLatencies[middle]!
      : (deliveredLatencies[middle - 1]! + deliveredLatencies[middle]!) / 2
    : null
  return {
    replies: rows.length,
    deliveredToRootAuthor: rows.filter((row) => row.rootAuthorDeliveredAt !== null).length,
    deliveredToSuccessorInstead: rows.filter(
      (row) => row.rootAuthorDeliveredAt === null && row.successorDeliveredAt !== null,
    ).length,
    medianFirstDeliveryLatencyMs,
    worstFirstDeliveryLatencyMs: deliveredLatencies.at(-1) ?? null,
    deliveredToNobody: rows
      .filter((row) => row.firstDeliveredAt === null)
      .map(({ messageSource, replyId, title }) => ({ messageSource, replyId, title })),
  }
}

type MessageFacts = {
  audience: string
  acknowledgementRequired: boolean
  purpose: BoardPurpose
  postedAt: string
  expiresAt: string | null
  postingProject: string | null
}

export type PreparedBoardReach = BoardReachRecordingInput &
  MessageFacts & {
    readerProject: string
    sessionStartedAt: string
    concern: BoardReachConcern
  }

function taskProject(key: string, database: Database): string | null {
  const prefix = /^([A-Z][A-Z0-9]*)-/.exec(key)?.[1]
  if (!prefix) return null
  return (
    projects(undefined, database).find((project) => project.settings.keyPrefixes?.includes(prefix))
      ?.name ?? null
  )
}

export function boardReachConcern(
  audience: Audience,
  readerSession: string,
  readerProject: string,
  resolvedTaskProject: string | null,
  postingProject: string | null = null,
): BoardReachConcern {
  const byProject = audienceProjectConcern(
    audience,
    readerProject,
    resolvedTaskProject,
    postingProject,
  )
  if (byProject) return byProject
  if (audience.kind === 'session')
    return audience.value === readerSession ? 'concerned' : 'not-concerned'
  if (audience.kind === 'run')
    return readerSession === `run:${audience.value}` ? 'concerned' : 'not-concerned'
  return 'unqualified'
}

function audienceProjectConcern(
  audience: Audience,
  readerProject: string,
  resolvedTaskProject: string | null,
  postingProject: string | null,
): BoardReachConcern | null {
  if (audience.kind === 'architects')
    return projectConcern(audience.all ? null : (audience.value ?? postingProject), readerProject)
  if (audience.kind === 'project' || audience.kind === 'workers')
    return projectConcern(audience.value, readerProject)
  if (audience.kind === 'task') return projectConcern(resolvedTaskProject, readerProject)
  return null
}

function projectConcern(project: string | null, readerProject: string): BoardReachConcern {
  if (project === null) return 'unqualified'
  return project === readerProject ? 'concerned' : 'not-concerned'
}

function localMessageFacts(id: string, database: Database): MessageFacts | null {
  const row = database
    .query(`SELECT ${BOARD_MESSAGE_COLUMNS} FROM board_message WHERE record_id=?`)
    .get(id) as MessageRow | null
  const root =
    row?.kind === 'reply' && row.thread_root_record_id !== null
      ? (database
          .query(`SELECT ${BOARD_MESSAGE_COLUMNS} FROM board_message WHERE record_id=?`)
          .get(row.thread_root_record_id) as MessageRow | null)
      : row
  return row && root?.audience
    ? {
        audience: root.audience,
        acknowledgementRequired: row.ack_required === 1,
        purpose: root.purpose ?? 'information',
        postedAt: row.created_at,
        expiresAt: root.expires_at,
        postingProject: root.author_project,
      }
    : null
}

function hostedMessageFacts(id: string, database: Database): MessageFacts | null {
  const cached = database
    .query('SELECT payload FROM hosted_board_message_cache WHERE id=?')
    .get(id) as { payload: string } | null
  if (!cached) return null
  const message = JSON.parse(cached.payload) as HostedBoardMessage
  const root =
    message.kind === 'reply' && message.threadRootId
      ? (database
          .query('SELECT payload FROM hosted_board_message_cache WHERE id=?')
          .get(message.threadRootId) as { payload: string } | null)
      : null
  const audienceOwner = root ? (JSON.parse(root.payload) as HostedBoardMessage) : message
  return audienceOwner.audience
    ? {
        audience: audienceOwner.audience,
        acknowledgementRequired: message.ackRequired,
        purpose: audienceOwner.purpose ?? 'information',
        postedAt: message.createdAt,
        expiresAt: audienceOwner.expiresAt,
        postingProject: audienceOwner.origin.project,
      }
    : null
}

export function prepareBoardReach(
  input: BoardReachRecordingInput,
  database: Database,
): PreparedBoardReach {
  const presence = database
    .query(
      'SELECT project,COALESCE(first_seen,last_seen) started_at FROM presence WHERE session_id=?',
    )
    .get(input.session) as { project: string; started_at: string } | null
  if (!presence) throw new Error(`no presence for pushed board reader ${input.session}`)
  const message =
    input.messageSource === 'local'
      ? localMessageFacts(input.messageId, database)
      : hostedMessageFacts(input.messageId, database)
  if (!message) throw new Error(`no ${input.messageSource} board message ${input.messageId}`)
  const audience = parseAudience(message.audience)
  return {
    ...input,
    ...message,
    readerProject: presence.project,
    sessionStartedAt: presence.started_at,
    concern: boardReachConcern(
      audience,
      input.session,
      presence.project,
      audience.kind === 'task' ? taskProject(String(audience.value), database) : null,
      message.postingProject,
    ),
  }
}

export function recordBoardReach(input: PreparedBoardReach, database: Database): void {
  database
    .query(
      `INSERT INTO board_reach_delivery
       (emission_id,message_source,message_record_id,reader_session,reader_project,delivery_point,blocked_stop,
        audience,acknowledgement_required,purpose,posted_at,expires_at,session_started_at,posting_timing,
        concern,recorded_at,record_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(emission_id,message_source,message_record_id) WHERE emission_id IS NOT NULL DO NOTHING`,
    )
    .run(
      input.emissionId,
      input.messageSource,
      input.messageId,
      input.session,
      input.readerProject,
      input.deliveryPoint,
      input.blockedStop ? 1 : 0,
      input.audience,
      input.acknowledgementRequired ? 1 : 0,
      input.purpose,
      input.postedAt,
      input.expiresAt,
      input.sessionStartedAt,
      input.postedAt < input.sessionStartedAt ? 'before-session' : 'after-session',
      input.concern,
      input.recordedAt,
      newRecordId(),
    )
}

export function reapBoardReach(clock = Date.now(), database: Database = db()): number {
  const cutoff = new Date(clock - BOARD_REACH_RETENTION_HOURS * 60 * 60 * 1_000).toISOString()
  return (
    database.query('DELETE FROM board_reach_delivery WHERE recorded_at<?').run(cutoff).changes +
    database.query('DELETE FROM board_reach_recording_failure WHERE recorded_at<?').run(cutoff)
      .changes
  )
}

export function noteBoardReachRecordingFailure(database: Database, recordedAt: string): void {
  database
    .query('INSERT INTO board_reach_recording_failure(recorded_at,record_id) VALUES (?,?)')
    .run(recordedAt, newRecordId())
}

export function countBoardReach(rows: BoardReachRow[]) {
  const messages = new Map<
    string,
    {
      messageSource: 'local' | 'hosted'
      messageId: string
      audience: string
      pushes: number
      pushesNotConcerned: number
      pushesUnqualified: number
      pushesOlderThanSession: number
      stopsBlocked: number
      readerProjects: Set<string>
    }
  >()
  for (const row of rows) {
    const key = `${row.messageSource}:${row.messageId}`
    const current = messages.get(key) ?? {
      messageSource: row.messageSource,
      messageId: row.messageId,
      audience: row.audience,
      pushes: 0,
      pushesNotConcerned: 0,
      pushesUnqualified: 0,
      pushesOlderThanSession: 0,
      stopsBlocked: 0,
      readerProjects: new Set<string>(),
    }
    current.pushes++
    if (row.concern === 'not-concerned') current.pushesNotConcerned++
    if (row.concern === 'unqualified') current.pushesUnqualified++
    if (row.postingTiming === 'before-session') current.pushesOlderThanSession++
    if (row.blockedStop) current.stopsBlocked++
    current.readerProjects.add(row.readerProject)
    messages.set(key, current)
  }
  const worstMessages = [...messages.values()]
    .map((message) => ({
      ...message,
      pushesNotShownToConcernReader: message.pushesNotConcerned + message.pushesUnqualified,
      readerProjects: [...message.readerProjects].sort(),
    }))
    .filter((message) => message.pushesNotShownToConcernReader > 0)
    .sort(
      (left, right) =>
        right.pushesNotShownToConcernReader - left.pushesNotShownToConcernReader ||
        right.pushes - left.pushes,
    )
    .slice(0, 10)
  return {
    messagesPushed: messages.size,
    pushes: rows.length,
    pushesByPurpose: Object.fromEntries(
      (['information', 'request', 'standing'] as const).map((purpose) => [
        purpose,
        rows.filter((row) => (row.purpose ?? 'information') === purpose).length,
      ]),
    ),
    pushesNotConcerned: rows.filter((row) => row.concern === 'not-concerned').length,
    pushesUnqualified: rows.filter((row) => row.concern === 'unqualified').length,
    pushesOlderThanSession: rows.filter((row) => row.postingTiming === 'before-session').length,
    audienceAtPostingZero: rows.filter((row) => row.audienceAtPosting === false).length,
    audienceAtPostingNull: rows.filter((row) => row.audienceAtPosting === null).length,
    successorDeliveries: rows.filter((row) => row.successor).length,
    stopsBlockedWithoutAcknowledgement: rows.filter(
      (row) => row.blockedStop && !row.acknowledgementRequired,
    ).length,
    worstMessages,
  }
}

function boardMessageTitle(
  source: 'local' | 'hosted',
  id: string,
  database: Database,
): string | null {
  if (source === 'local') {
    const row = database
      .query('SELECT title,thread_root_record_id FROM board_message WHERE record_id=?')
      .get(id) as { title: string | null; thread_root_record_id: string | null } | null
    if (!row) return null
    if (row.title) return row.title
    if (row.thread_root_record_id === null) return null
    return (
      (
        database
          .query('SELECT title FROM board_message WHERE record_id=?')
          .get(row.thread_root_record_id) as {
          title: string | null
        } | null
      )?.title ?? null
    )
  }
  const cached = database
    .query('SELECT payload FROM hosted_board_message_cache WHERE id=?')
    .get(id) as { payload: string } | null
  if (!cached) return null
  const message = JSON.parse(cached.payload) as HostedBoardMessage
  if (message.title) return message.title
  if (!message.threadRootId) return null
  const root = database
    .query('SELECT payload FROM hosted_board_message_cache WHERE id=?')
    .get(message.threadRootId) as { payload: string } | null
  return root ? (JSON.parse(root.payload) as HostedBoardMessage).title : null
}

const reachRow = (row: Record<string, unknown>): BoardReachRow => ({
  recordId: String(row.record_id),
  messageSource: row.message_source as 'local' | 'hosted',
  messageId: String(row.message_record_id),
  readerSession: String(row.reader_session),
  readerProject: String(row.reader_project),
  deliveryPoint: row.delivery_point as BoardDeliveryPoint,
  blockedStop: row.blocked_stop === 1,
  audience: String(row.audience),
  acknowledgementRequired: row.acknowledgement_required === 1,
  purpose: parseBoardPurpose(row.purpose === undefined ? undefined : String(row.purpose)),
  postedAt: String(row.posted_at),
  expiresAt: row.expires_at === null ? null : String(row.expires_at),
  sessionStartedAt: String(row.session_started_at),
  postingTiming: row.posting_timing as 'before-session' | 'after-session',
  concern: row.concern as BoardReachConcern,
  recordedAt: String(row.recorded_at),
  audienceAtPosting:
    row.audience_at_posting === 1 ? true : row.audience_at_posting === 0 ? false : null,
  successor: row.successor === 1,
})

function localReplyReachRows(windowStart: string, database: Database): BoardReplyReachRow[] {
  return (
    database
      .query(
        `SELECT reply.record_id AS reply_id,root.title,reply.created_at,
                MIN(CASE WHEN receipt.reader_session=root.author_session THEN receipt.delivered_at END) AS root_author_delivered_at,
                MIN(CASE WHEN receipt.successor=1 THEN receipt.delivered_at END) AS successor_delivered_at,
                MIN(receipt.delivered_at) AS first_delivered_at
         FROM board_message reply
         JOIN board_message root ON root.record_id=reply.thread_root_record_id
         LEFT JOIN board_receipt receipt ON receipt.message_record_id=reply.record_id
         WHERE reply.kind='reply' AND reply.created_at>=? AND root.author_session IS NOT NULL
         GROUP BY reply.record_id,root.title,reply.created_at
         ORDER BY reply.created_at,reply.record_id`,
      )
      .all(windowStart) as Array<{
      reply_id: string
      title: string | null
      created_at: string
      root_author_delivered_at: string | null
      successor_delivered_at: string | null
      first_delivered_at: string | null
    }>
  ).map((row) => ({
    messageSource: 'local',
    replyId: row.reply_id,
    title: row.title,
    createdAt: row.created_at,
    rootAuthorDeliveredAt: row.root_author_delivered_at,
    successorDeliveredAt: row.successor_delivered_at,
    firstDeliveredAt: row.first_delivered_at,
  }))
}

function hostedReplyReachRows(windowStart: string, database: Database): BoardReplyReachRow[] {
  const messages = cachedHostedBoardMessages(database)
  const roots = new Map(messages.map((message) => [message.id, message]))
  return messages
    .filter((message) => {
      if (
        message.kind !== 'reply' ||
        message.threadRootId === null ||
        message.createdAt < windowStart
      )
        return false
      const root = roots.get(message.threadRootId)
      return Boolean(root && root.authorSession !== null)
    })
    .map((message) => {
      const root = roots.get(message.threadRootId!)!
      const receipts = database
        .query(
          `SELECT reader_session,successor,delivered_at FROM hosted_board_receipt_cache
           WHERE message_id=? AND delivered_at IS NOT NULL ORDER BY delivered_at`,
        )
        .all(message.id) as Array<{
        reader_session: string
        successor: number
        delivered_at: string
      }>
      return {
        messageSource: 'hosted' as const,
        replyId: message.id,
        title: root.title,
        createdAt: message.createdAt,
        rootAuthorDeliveredAt:
          receipts.find((receipt) => receipt.reader_session === root.authorSession)?.delivered_at ??
          null,
        successorDeliveredAt:
          receipts.find((receipt) => receipt.successor === 1)?.delivered_at ?? null,
        firstDeliveredAt: receipts[0]?.delivered_at ?? null,
      }
    })
}

export function boardReachReport(
  hours = BOARD_REACH_DEFAULT_HOURS,
  clock = Date.now(),
  database = db(),
) {
  const recording = database
    .query('SELECT started_at FROM board_reach_recording WHERE singleton=1')
    .get() as { started_at: string }
  const windowStart = new Date(clock - hours * 60 * 60 * 1_000).toISOString()
  const failures = database
    .query('SELECT COUNT(*) count FROM board_reach_recording_failure WHERE recorded_at>=?')
    .get(windowStart) as { count: number }
  const rows = (
    database
      .query(
        `SELECT ${BOARD_REACH_DELIVERY_COLUMNS},
                CASE message_source
                  WHEN 'local' THEN (
                    SELECT audience_at_posting FROM board_receipt
                    WHERE message_record_id=board_reach_delivery.message_record_id
                      AND reader_session=board_reach_delivery.reader_session
                  )
                  ELSE (
                    SELECT audience_at_posting FROM hosted_board_receipt_cache
                    WHERE message_id=board_reach_delivery.message_record_id
                      AND reader_session=board_reach_delivery.reader_session
                  )
                END AS audience_at_posting,
                CASE message_source
                  WHEN 'local' THEN (
                    SELECT successor FROM board_receipt
                    WHERE message_record_id=board_reach_delivery.message_record_id
                      AND reader_session=board_reach_delivery.reader_session
                  )
                  ELSE (
                    SELECT successor FROM hosted_board_receipt_cache
                    WHERE message_id=board_reach_delivery.message_record_id
                      AND reader_session=board_reach_delivery.reader_session
                  )
                END AS successor
         FROM board_reach_delivery WHERE recorded_at>=? ORDER BY recorded_at,record_id`,
      )
      .all(windowStart) as Record<string, unknown>[]
  ).map(reachRow)
  const totals = countBoardReach(rows)
  const replyRows = [
    ...localReplyReachRows(windowStart, database),
    ...hostedReplyReachRows(windowStart, database),
  ]
  return {
    windowHours: hours,
    windowStart,
    coveredFrom: windowStart > recording.started_at ? windowStart : recording.started_at,
    coveredTo: new Date(clock).toISOString(),
    partial: recording.started_at > windowStart,
    recordingStartedAt: recording.started_at,
    recordingFailures: failures.count,
    totals: {
      ...totals,
      worstMessages: totals.worstMessages.map((message) => ({
        ...message,
        title: boardMessageTitle(message.messageSource, message.messageId, database),
      })),
    },
    replies: {
      ...countBoardReplyReach(replyRows),
      rows: replyRows,
    },
    rows,
  }
}

export function renderBoardReach(report: ReturnType<typeof boardReachReport>): string {
  const coverage = `Covered ${report.coveredFrom} to ${report.coveredTo}${report.partial ? ' (partial window)' : ''}. Recording failures: ${report.recordingFailures}.`
  const totals = report.totals
  const lines = [coverage]
  if (!report.rows.length)
    lines.push(
      `No board pushes recorded in this window. Recording has existed since ${report.recordingStartedAt}.`,
    )
  else
    lines.push(
      `Messages pushed: ${totals.messagesPushed}`,
      `Pushes: ${totals.pushes}`,
      `Pushes by purpose: information ${totals.pushesByPurpose.information}, request ${totals.pushesByPurpose.request}, standing ${totals.pushesByPurpose.standing}`,
      `Pushes not concerning the reader's project: ${totals.pushesNotConcerned}`,
      `Pushes of unqualified messages: ${totals.pushesUnqualified}`,
      `Pushes older than the session: ${totals.pushesOlderThanSession}`,
      `Pushes with audience_at_posting 0: ${totals.audienceAtPostingZero}`,
      `Pushes with audience_at_posting unset: ${totals.audienceAtPostingNull}`,
      `Successor deliveries: ${totals.successorDeliveries}`,
      `Stops blocked without acknowledgement required: ${totals.stopsBlockedWithoutAcknowledgement}`,
    )
  if (totals.worstMessages.length) {
    lines.push('Worst messages by pushes not shown to concern the reader:')
    for (const message of totals.worstMessages)
      lines.push(
        `${message.messageId}${message.title ? ` — ${message.title}` : ''} [${message.audience}]: ${message.pushesNotShownToConcernReader} not shown to concern (${message.pushesNotConcerned} not concerning, ${message.pushesUnqualified} unqualified); ${message.pushesOlderThanSession} older than the session; ${message.stopsBlocked} blocked stops; projects: ${message.readerProjects.join(', ')}`,
      )
  }
  const reply = report.replies
  lines.push(
    'Reply delivery:',
    `Replies with a session-authored root: ${reply.replies}`,
    `Delivered to the root author: ${reply.deliveredToRootAuthor}`,
    `Delivered to a successor instead: ${reply.deliveredToSuccessorInstead}`,
    `First-delivery latency: median ${reply.medianFirstDeliveryLatencyMs === null ? 'none' : `${reply.medianFirstDeliveryLatencyMs} ms`}, worst ${reply.worstFirstDeliveryLatencyMs === null ? 'none' : `${reply.worstFirstDeliveryLatencyMs} ms`}`,
    `Replies delivered to nobody: ${reply.deliveredToNobody.length}`,
  )
  for (const message of reply.deliveredToNobody)
    lines.push(`${message.replyId}${message.title ? ` — ${message.title}` : ''}`)
  return lines.join('\n')
}
