// concern: board-reach-measurement
/** Records push facts and turns them into the board noise decision surface. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { projects } from '../project/projects.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import type { MessageRow } from './board-store.ts'

export const BOARD_REACH_DEFAULT_HOURS = 24

export type BoardDeliveryPoint = 'session-start' | 'after-tool-call' | 'stop'
export type BoardReachConcern = 'concerned' | 'not-concerned' | 'unqualified'

export type BoardReachRow = {
  id: number
  messageSource: 'local' | 'hosted'
  messageId: string
  readerSession: string
  readerProject: string
  deliveryPoint: BoardDeliveryPoint
  blockedStop: boolean
  audience: string
  acknowledgementRequired: boolean
  postedAt: string
  expiresAt: string | null
  sessionStartedAt: string
  postingTiming: 'before-session' | 'after-session'
  concern: BoardReachConcern
  recordedAt: string
}

export type BoardReachRecordingInput = {
  session: string
  messageSource: 'local' | 'hosted'
  messageId: string
  deliveryPoint: BoardDeliveryPoint
  blockedStop: boolean
  recordedAt: string
}

type MessageFacts = {
  audience: string
  acknowledgementRequired: boolean
  postedAt: string
  expiresAt: string | null
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
  audience: string,
  readerSession: string,
  readerProject: string,
  database: Database,
): BoardReachConcern {
  const scoped = /^(?:project|workers):(.+)$/.exec(audience)
  if (scoped) return scoped[1] === readerProject ? 'concerned' : 'not-concerned'
  const task = /^task:(.+)$/.exec(audience)
  if (task) {
    const project = taskProject(task[1]!, database)
    return project === null
      ? 'unqualified'
      : project === readerProject
        ? 'concerned'
        : 'not-concerned'
  }
  const session = /^session:(.+)$/.exec(audience)
  if (session) return session[1] === readerSession ? 'concerned' : 'not-concerned'
  const run = /^run:(.+)$/.exec(audience)
  if (run) return readerSession === `run:${run[1]}` ? 'concerned' : 'not-concerned'
  return 'unqualified'
}

function localMessageFacts(id: string, database: Database): MessageFacts | null {
  const row = database
    .query('SELECT * FROM board_message WHERE id=?')
    .get(Number(id)) as MessageRow | null
  const root =
    row?.kind === 'reply' && row.thread_root_id !== null
      ? (database
          .query('SELECT * FROM board_message WHERE id=?')
          .get(row.thread_root_id) as MessageRow | null)
      : row
  return row && root?.audience
    ? {
        audience: root.audience,
        acknowledgementRequired: row.ack_required === 1,
        postedAt: row.created_at,
        expiresAt: root.expires_at,
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
        postedAt: message.createdAt,
        expiresAt: audienceOwner.expiresAt,
      }
    : null
}

export function recordBoardReach(input: BoardReachRecordingInput, database: Database): void {
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
  database
    .query(
      `INSERT INTO board_reach_delivery
       (message_source,message_id,reader_session,reader_project,delivery_point,blocked_stop,
        audience,acknowledgement_required,posted_at,expires_at,session_started_at,posting_timing,
        concern,recorded_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.messageSource,
      input.messageId,
      input.session,
      presence.project,
      input.deliveryPoint,
      input.blockedStop ? 1 : 0,
      message.audience,
      message.acknowledgementRequired ? 1 : 0,
      message.postedAt,
      message.expiresAt,
      presence.started_at,
      message.postedAt < presence.started_at ? 'before-session' : 'after-session',
      boardReachConcern(message.audience, input.session, presence.project, database),
      input.recordedAt,
    )
}

export function noteBoardReachRecordingFailure(database: Database, recordedAt: string): void {
  database
    .query('INSERT INTO board_reach_recording_failure(recorded_at) VALUES (?)')
    .run(recordedAt)
}

export function countBoardReach(rows: BoardReachRow[]) {
  const messages = new Map<
    string,
    { messageId: string; audience: string; pushes: number; unrelated: number }
  >()
  for (const row of rows) {
    const key = `${row.messageSource}:${row.messageId}`
    const current = messages.get(key) ?? {
      messageId: row.messageId,
      audience: row.audience,
      pushes: 0,
      unrelated: 0,
    }
    current.pushes++
    if (row.concern === 'not-concerned') current.unrelated++
    messages.set(key, current)
  }
  return {
    messagesPushed: messages.size,
    pushes: rows.length,
    pushesNotConcerned: rows.filter((row) => row.concern === 'not-concerned').length,
    pushesOlderThanSession: rows.filter((row) => row.postingTiming === 'before-session').length,
    stopsBlockedWithoutAcknowledgement: rows.filter(
      (row) => row.blockedStop && !row.acknowledgementRequired,
    ).length,
    worstMessages: [...messages.values()]
      .filter((message) => message.unrelated > 0)
      .sort((left, right) => right.unrelated - left.unrelated || right.pushes - left.pushes)
      .slice(0, 10),
  }
}

const reachRow = (row: Record<string, unknown>): BoardReachRow => ({
  id: Number(row.id),
  messageSource: row.message_source as 'local' | 'hosted',
  messageId: String(row.message_id),
  readerSession: String(row.reader_session),
  readerProject: String(row.reader_project),
  deliveryPoint: row.delivery_point as BoardDeliveryPoint,
  blockedStop: row.blocked_stop === 1,
  audience: String(row.audience),
  acknowledgementRequired: row.acknowledgement_required === 1,
  postedAt: String(row.posted_at),
  expiresAt: row.expires_at === null ? null : String(row.expires_at),
  sessionStartedAt: String(row.session_started_at),
  postingTiming: row.posting_timing as 'before-session' | 'after-session',
  concern: row.concern as BoardReachConcern,
  recordedAt: String(row.recorded_at),
})

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
      .query('SELECT * FROM board_reach_delivery WHERE recorded_at>=? ORDER BY recorded_at,id')
      .all(windowStart) as Record<string, unknown>[]
  ).map(reachRow)
  return {
    windowHours: hours,
    windowStart,
    recordingStartedAt: recording.started_at,
    recordingFailures: failures.count,
    totals: countBoardReach(rows),
    rows,
  }
}

export function renderBoardReach(report: ReturnType<typeof boardReachReport>): string {
  if (!report.rows.length)
    return `No board pushes recorded in this window. Recording has existed since ${report.recordingStartedAt}.`
  const totals = report.totals
  const lines = [
    `Messages pushed: ${totals.messagesPushed}`,
    `Pushes: ${totals.pushes}`,
    `Pushes not concerning the reader's project: ${totals.pushesNotConcerned}`,
    `Pushes older than the session: ${totals.pushesOlderThanSession}`,
    `Stops blocked without acknowledgement required: ${totals.stopsBlockedWithoutAcknowledgement}`,
    `Recording failures: ${report.recordingFailures}`,
  ]
  if (totals.worstMessages.length) {
    lines.push('Worst messages by pushes not concerning the reader:')
    for (const message of totals.worstMessages)
      lines.push(
        `${message.messageId} [${message.audience}]: ${message.unrelated} of ${message.pushes}`,
      )
  }
  return lines.join('\n')
}
