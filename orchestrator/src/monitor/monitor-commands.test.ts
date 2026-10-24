import { expect, spyOn, test } from 'bun:test'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetPath } from '../../../shared/install-root.ts'
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
  const previousRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.CLAUDE_CODE_SESSION_ID = session
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
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
    if (previousRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousRecordApiUrl
  }
})

test('the acknowledgement reports its refusals beside the acknowledged ids as JSON', async () => {
  const session = 'monitor-ack-writer'
  const previousSession = process.env.CLAUDE_CODE_SESSION_ID
  const previousCapabilityPath = process.env.BOTTEGA_MONITOR_CAPABILITY_PATH
  const previousCapabilityToken = process.env.BOTTEGA_MONITOR_CAPABILITY_TOKEN
  const capabilityDir = realpathSync(mkdtempSync(join(tmpdir(), 'monitor-ack-')))
  chmodSync(capabilityDir, 0o700)
  const capabilityPath = join(capabilityDir, 'capability.json')
  const token = 'a'.repeat(64)
  writeFileSync(capabilityPath, JSON.stringify({ token, pid: process.ppid }), { mode: 0o600 })
  chmodSync(capabilityPath, 0o600)
  process.env.CLAUDE_CODE_SESSION_ID = session
  process.env.BOTTEGA_MONITOR_CAPABILITY_PATH = capabilityPath
  process.env.BOTTEGA_MONITOR_CAPABILITY_TOKEN = token
  // The capability is a live delivery hook; this test presents the hook's own
  // path from the process observation instead of running it.
  const hook = realpathSync(assetPath('orchestrator', 'hooks', 'session-brief.py'))
  const spawn = spyOn(Bun, 'spawnSync').mockImplementation((() => ({
    exitCode: 0,
    signalCode: null,
    exitedDueToTimeout: false,
    stdout: Buffer.from(`${hook}\n`),
    stderr: Buffer.from(''),
  })) as unknown as typeof Bun.spawnSync)
  const output: string[] = []
  const presentation = {
    log: (value: string) => output.push(value),
    error: (_value: string) => undefined,
    write: async (value: string) => {
      output.push(value)
    },
    setExitCode: (_code: number) => undefined,
  }
  try {
    await monitorCommand(
      {
        ackNotices: 'condition:1,landing:not-a-uuid,condition:007,not-a-source:1',
        notices: false,
        history: false,
        backstop: false,
        lockHolder: false,
        limit: 20,
        json: true,
        skipBoardRefresh: true,
      },
      presentation,
    )

    expect(JSON.parse(output.pop()!)).toEqual({
      acknowledged: ['condition:1'],
      refused: [
        { id: 'landing:not-a-uuid', reason: 'a landing id is a version-7 UUID' },
        { id: 'condition:007', reason: 'a condition id is a positive integer' },
        {
          id: 'not-a-source:1',
          reason: 'a notice id is <source>:<identifier> with source condition, landing or board',
        },
      ],
    })
  } finally {
    spawn.mockRestore()
    rmSync(capabilityDir, { recursive: true, force: true })
    if (previousSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previousSession
    if (previousCapabilityPath === undefined) delete process.env.BOTTEGA_MONITOR_CAPABILITY_PATH
    else process.env.BOTTEGA_MONITOR_CAPABILITY_PATH = previousCapabilityPath
    if (previousCapabilityToken === undefined) delete process.env.BOTTEGA_MONITOR_CAPABILITY_TOKEN
    else process.env.BOTTEGA_MONITOR_CAPABILITY_TOKEN = previousCapabilityToken
  }
})
