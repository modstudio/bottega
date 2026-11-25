import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from '../board/board-mode.ts'
import { db } from '../database/db.ts'
import { RecordApiRequestError } from '../record/record-api-client-response.ts'
import type { SessionCloseOutReport } from '../session/session-close-out.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { sweepSessionCloseOutRecords } from './cleanup-sweep-session-close-out.ts'
import { releaseHostedClaims } from './cleanup-sweep-session-close-out-hosted.ts'

const clock = Date.parse('2026-11-09T12:02:00.000Z')
const closedAt = '2026-11-09T12:00:00.000Z'

afterEach(() => installRecordApiClient(null))

function presentation(lines: string[]): CleanupPresentation {
  return {
    log: (...values) => lines.push(values.join(' ')),
    error: (...values) => lines.push(values.join(' ')),
    setExitCode: () => {},
    keptBranchLine: () => '',
  }
}

function closeOutReport(session: string): SessionCloseOutReport {
  return {
    session,
    dryRun: false,
    resume: false,
    owned: {
      runs: [],
      branches: [],
      claims: [],
      landings: [],
      reviews: [],
      cursors: [],
      contextItems: [],
    },
    mechanical: [],
    reported: [],
    kept: [],
    parked: [],
    process: [],
    warnings: [],
    errors: [],
    heldTrees: [],
    verdict: { clean: true, residue: 0 },
    recommendation: 'clear',
  }
}

function hostedFixture() {
  const database = db()
  const insertCloseOut = database.query(
    `INSERT INTO session_close_out
     (record_id,session_id,closed_at,clean,recommendation,mechanical_count,process_count,error_count,warning_count)
     VALUES (?,?,?,1,'clear',1,0,0,0)`,
  )
  const insertSeen = database.query('INSERT INTO session_seen(session_id,last_seen) VALUES (?,?)')
  const addSession = () => {
    const session = newRecordId()
    insertCloseOut.run(newRecordId(), session, closedAt)
    insertSeen.run(session, closedAt)
    return session
  }
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const priorUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
  const restore = () => {
    database.query('DELETE FROM schema_meta WHERE key=?').run(BOARD_HOSTED_ADOPTED_KEY)
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
  return { database, addSession, restore }
}

test('hosted claim release stamps final refusals and defers authentication failures', async () => {
  const { database, addSession, restore } = hostedFixture()
  try {
    const finalSession = addSession()
    const finalCalls: string[] = []
    const finalLines: string[] = []
    const finalError =
      'a machine-derived operator session cannot be released\npass the harness session id to release its claims'
    const sweepFinal = () =>
      sweepSessionCloseOutRecords({
        enabled: true,
        dryRun: false,
        database,
        now: clock,
        presentation: presentation(finalLines),
        adapters: {
          release: async (session) => closeOutReport(session),
          releaseHostedClaims: async (session) => {
            finalCalls.push(session)
            throw new RecordApiRequestError(finalError, 'refused', 400)
          },
        },
      })
    await expect(sweepFinal()).resolves.toBe(false)
    expect(finalCalls).toEqual([finalSession])
    expect(
      database.query('SELECT swept_at FROM session_close_out WHERE session_id=?').get(finalSession),
    ).toEqual({ swept_at: new Date(clock).toISOString() })
    expect(
      database.query('SELECT session_id FROM session_seen WHERE session_id=?').get(finalSession),
    ).toBeNull()
    expect(finalLines.join('\n')).toContain(finalError)
    expect(finalLines.join('\n')).toContain('they are left to lapse')
    await expect(sweepFinal()).resolves.toBe(false)
    expect(finalCalls).toEqual([finalSession])

    const authSessions = [addSession(), addSession()]
    const authCalls: string[] = []
    const authLines: string[] = []
    await expect(
      sweepSessionCloseOutRecords({
        enabled: true,
        dryRun: false,
        database,
        now: clock,
        presentation: presentation(authLines),
        adapters: {
          release: async (session) => closeOutReport(session),
          releaseHostedClaims: async (session) => {
            authCalls.push(session)
            throw new RecordApiRequestError('record session expired', 'refused', 401)
          },
        },
      }),
    ).resolves.toBe(true)
    expect(authCalls).toHaveLength(1)
    expect(
      database
        .query(
          `SELECT COUNT(*) count FROM session_close_out
           WHERE session_id IN (?,?) AND swept_at IS NOT NULL`,
        )
        .get(...authSessions),
    ).toEqual({ count: 0 })
    expect(authLines.join('\n')).toContain(`${PLATFORM_SLUG} record sign-in`)
    expect(authLines.join('\n')).not.toContain(`retry: ${PLATFORM_SLUG} machine sweep`)
  } finally {
    restore()
  }
})

test('a session resumed during release is not released from the hosted board', async () => {
  const { database, addSession, restore } = hostedFixture()
  const session = addSession()
  const hostedCalls: string[] = []
  try {
    await expect(
      sweepSessionCloseOutRecords({
        enabled: true,
        dryRun: false,
        database,
        now: clock,
        presentation: presentation([]),
        adapters: {
          release: async (releasedSession) => {
            database
              .query('UPDATE session_seen SET last_seen=? WHERE session_id=?')
              .run('2026-11-09T12:01:00.000Z', releasedSession)
            return closeOutReport(releasedSession)
          },
          releaseHostedClaims: async (releasedSession) => {
            hostedCalls.push(releasedSession)
            return 0
          },
        },
      }),
    ).resolves.toBe(false)
    expect(hostedCalls).toEqual([])
    expect(
      database.query('SELECT swept_at FROM session_close_out WHERE session_id=?').get(session),
    ).toEqual({ swept_at: null })
  } finally {
    restore()
  }
})

test('hosted claim release falls back from an undeclared presence project', async () => {
  const database = db()
  const session = newRecordId()
  database
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
       VALUES (?,'codex','architect','fixture','undeclared-project','/tmp',NULL,?)`,
    )
    .run(session, new Date().toISOString())
  const destinations: Array<string | null | undefined> = []
  const memory = createMemoryRecordApiClient()
  installRecordApiClient({
    ...memory,
    releaseBoardSessionClaims: async (input, destination) => {
      expect(input).toEqual({ holderSession: session })
      expect(destination).toEqual({ destinationSpaceId: 'personal-space' })
      return { released: 2 }
    },
  })
  await expect(
    releaseHostedClaims(session, database, async (_client, project) => {
      destinations.push(project)
      if (project !== null)
        throw new RecordApiRequestError('project has no declared record space', 'refused', 409)
      return { destinationSpaceId: 'personal-space' }
    }),
  ).resolves.toBe(2)
  expect(destinations).toEqual(['undeclared-project', null])
})
