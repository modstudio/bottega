import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { BOARD_CACHE_OWNER_KEY } from '../board/board-hosted-cache.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from '../board/board-mode.ts'
import { postNotice } from '../board/board-service.ts'
import { db } from '../database/db.ts'
import { formatHostLoadLine, monitorCommand } from './monitor-commands.ts'
import type { MonitorHostLoad } from './monitor-types.ts'

const hostLoad: MonitorHostLoad = {
  gates: 0,
  loadavg: 15.75,
  ncpu: 16,
  freeMem: 1,
  pressure: 'normal',
  swapUsed: 0,
  swapTotal: 0,
  recentAdmissions: 0,
  waitingRequests: 0,
  oldestWaitMs: 0,
  liveRuns: 20,
}

test('the host line reports the run queue beside gate broker waiters', () => {
  expect(
    formatHostLoadLine(hostLoad, { waiting: 11, oldestWaitMs: 540_000, heldOn: ['load'] }),
  ).toContain(
    '0 broker request(s) waiting, oldest 0ms; 11 run(s) waiting for host capacity, oldest 540000ms, held on load',
  )
})

test('the host line names how many waiters sit behind the head', () => {
  expect(
    formatHostLoadLine(hostLoad, { waiting: 3, oldestWaitMs: 1_000, heldOn: ['load', 'memory'] }),
  ).toContain(
    '3 run(s) waiting for host capacity, oldest 1000ms, held on load+memory; 2 queued behind',
  )
})

test('notice command maps skip-board-refresh to hosted refresh behavior', async () => {
  const session = 'monitor-command-reader'
  const userId = newRecordId()
  const previousSession = process.env.CLAUDE_CODE_SESSION_ID
  const previousRecordApiUrl = process.env.ORCH_RECORD_API_URL
  process.env.CLAUDE_CODE_SESSION_ID = session
  process.env.ORCH_RECORD_API_URL = 'https://record.test'
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_CACHE_OWNER_KEY, userId)
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','machine','monitor-project',(SELECT record_id FROM project WHERE name='monitor-project'),'/tmp',NULL,?,?)`,
    )
    .run(session, new Date(Date.now() - 1_000).toISOString(), new Date().toISOString())
  const posted = postNotice(
    {
      audience: `session:${session}`,
      title: 'Command flag mapping',
      body: 'The command presentation includes this notice.',
      ackRequired: false,
    },
    {},
  )
  let changesCalls = 0
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    listBoardChanges: async () => {
      changesCalls++
      return { userId, items: [], highestRevision: null }
    },
  })
  const output: string[] = []
  const presentation = {
    log: (value: string) => output.push(value),
    error: (_value: string) => undefined,
    write: async (value: string) => {
      output.push(value)
    },
    setExitCode: (_code: number) => undefined,
  }
  const options = (skipBoardRefresh: boolean) => ({
    notices: true,
    history: false,
    backstop: false,
    lockHolder: false,
    limit: 20,
    json: true,
    skipBoardRefresh,
  })

  try {
    await monitorCommand(options(true), presentation)
    expect(changesCalls).toBe(0)
    expect(
      JSON.parse(output.pop()!).notices.map((notice: { noticeId: string }) => notice.noticeId),
    ).toContain(`board:${posted.number}`)

    await monitorCommand(options(false), presentation)
    expect(changesCalls).toBe(1)
    expect(
      JSON.parse(output.pop()!).notices.map((notice: { noticeId: string }) => notice.noticeId),
    ).toContain(`board:${posted.number}`)
  } finally {
    installRecordApiClient(null)
    if (previousSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previousSession
    if (previousRecordApiUrl === undefined) delete process.env.ORCH_RECORD_API_URL
    else process.env.ORCH_RECORD_API_URL = previousRecordApiUrl
  }
})
