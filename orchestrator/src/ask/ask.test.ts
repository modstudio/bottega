import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { BOARD_CACHE_OWNER_KEY } from '../board/board-hosted-cache.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from '../board/board-mode.ts'
import { postNotice } from '../board/board-service.ts'
import { db } from '../database/db.ts'
import { readEventLog, runEventsPath } from '../events.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import { ask, createAskMcpServer } from './ask.ts'
import { observeAskTransport } from './ask-lifecycle.ts'

async function askClient(
  runId: number,
  token = '',
  timeoutMs?: number,
  dependencies?: Parameters<typeof createAskMcpServer>[3],
) {
  const server = createAskMcpServer(runId, token, timeoutMs, dependencies)
  const client = new Client({ name: 'orch-ask-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { type: 'text'; text: string }[])[0]!.text
}

const createdAt = new Date(Date.now() - 1_000).toISOString()

beforeEach(() => {
  process.env.ORCH_RECORD_API_URL = 'https://record.test'
})
afterEach(() => {
  installRecordApiClient(null)
  delete process.env.ORCH_RECORD_API_URL
})

describe('the live ask channel always answers', () => {
  test('reports registered tools for writers, readers, and unauthenticated runs', () => {
    const writer = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const reader = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
    db().query('UPDATE run SET run_token=? WHERE id=?').run('writer-token', writer)
    const toolsFor = (runId: number, token = '') => {
      let names: string[] = []
      createAskMcpServer(runId, token, undefined, {
        fileWorkerNote: async () => ({ noteId: 1, candidateIds: [] }),
        lifecycle: {
          started: (tools) => {
            names = tools
          },
          initialised: () => {},
        },
      })
      return names.sort()
    }
    const base = [
      'ask_orchestrator',
      'check_orchestrator_messages',
      'message_orchestrator',
      'note',
      'suggest_board_post',
    ]
    expect(toolsFor(writer, 'writer-token')).toEqual([...base, 'run_gate'].sort())
    expect(toolsFor(reader)).toEqual([...base, 'gate_result'].sort())
    expect(toolsFor(writer, 'not-the-run-token')).toEqual(base.sort())
  })

  test('reports a completed initialise through the SDK hook', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    let initialised = 0
    const connection = await askClient(run, '', undefined, {
      fileWorkerNote: async () => ({ noteId: 1, candidateIds: [] }),
      lifecycle: {
        started: () => {},
        initialised: () => {
          initialised += 1
        },
      },
    })
    try {
      expect(initialised).toBe(1)
    } finally {
      await connection.close()
    }
  })

  test('observes the names returned by tools/list at the transport boundary', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const server = createAskMcpServer(run, '')
    const client = new Client({ name: 'orch-ask-list-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(observeAskTransport(serverTransport, run))
    await client.connect(clientTransport)
    try {
      const listed = await client.listTools()
      const event = readEventLog(runEventsPath(run)).findLast((item) => item.type === 'ask_listed')
      expect(event).toEqual({
        ts: expect.any(String),
        type: 'ask_listed',
        tools: listed.tools.map((tool) => tool.name),
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('check_orchestrator_messages emits hosted beside local once with the failed-refresh warning', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: 'ask-project' })
    db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
    const local = postNotice(
      { audience: `run:${run}`, title: 'Local ask', body: 'local ask body' },
      {},
      Date.parse(createdAt),
    )
    const hosted: HostedBoardMessage = {
      id: newRecordId(),
      kind: 'notice',
      threadRootId: null,
      title: 'Hosted ask',
      body: 'hosted ask body',
      audience: `run:${run}`,
      origin: {
        kind: 'architect',
        session: 'remote',
        harness: 'claude',
        project: 'ask-project',
        runId: null,
      },
      senderTags: [],
      createdAt,
      expiresAt: '2099-01-01T00:00:00.000Z',
      withdrawnAt: null,
      state: 'open',
      acceptedReplyId: null,
      acceptedBy: null,
      acceptedAt: null,
      noteId: null,
      notePendingError: null,
      revision: '1',
      scopeProjectIds: [],
      recipientUserIds: [],
      claimId: null,
      authorUserId: newRecordId(),
      authorSession: 'remote',
      ackRequired: false,
      ackDeadline: null,
    }
    db()
      .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
      .run(BOARD_CACHE_OWNER_KEY, hosted.authorUserId)
    db()
      .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
      .run('board_hosted_signed_in_user', hosted.authorUserId)
    db()
      .query(
        'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
      )
      .run(hosted.id, hosted.kind, hosted.threadRootId, hosted.revision, JSON.stringify(hosted))
    installRecordApiClient({
      ...createMemoryRecordApiClient(),
      listBoardChanges: async () => {
        throw new Error('ask refresh offline\nForged-Warning: ask')
      },
      putBoardReceipt: async () => {
        throw new Error('receipt offline')
      },
    })
    const connection = await askClient(run)
    try {
      const first = resultText(
        await connection.client.callTool({ name: 'check_orchestrator_messages', arguments: {} }),
      )
      expect(first).toContain(`BOARD NOTICE ${local.id}`)
      expect(first).toContain(`BOARD NOTICE ${hosted.id}`)
      expect(first).toContain('ask refresh offline')
      expect(first).toContain('offline Forged-Warning: ask')
      expect(first).not.toContain('offline\nForged-Warning: ask')
      const second = resultText(
        await connection.client.callTool({ name: 'check_orchestrator_messages', arguments: {} }),
      )
      expect(second).not.toContain(`BOARD NOTICE ${local.id}`)
      expect(second).not.toContain(`BOARD NOTICE ${hosted.id}`)
      expect(second).toContain('ask refresh offline')
      expect(second).not.toContain('offline\nForged-Warning: ask')
    } finally {
      await connection.close()
    }
  })

  test('writers receive run_gate while readers receive only the recorded gate result', async () => {
    const writer = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const reader = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
    const writerConnection = await askClient(writer)
    const readerConnection = await askClient(reader)
    try {
      const writerTools = await writerConnection.client.listTools()
      const readerTools = await readerConnection.client.listTools()
      expect(writerTools.tools.find((tool) => tool.name === 'note')).toBeDefined()
      expect(readerTools.tools.find((tool) => tool.name === 'note')).toBeDefined()
      expect(writerTools.tools.find((tool) => tool.name === 'suggest_board_post')).toBeDefined()
      expect(readerTools.tools.find((tool) => tool.name === 'suggest_board_post')).toBeDefined()
      expect(writerTools.tools.find((tool) => tool.name === 'run_gate')).toBeDefined()
      expect(writerTools.tools.find((tool) => tool.name === 'gate_result')).toBeUndefined()
      expect(readerTools.tools.find((tool) => tool.name === 'run_gate')).toBeUndefined()
      expect(readerTools.tools.find((tool) => tool.name === 'gate_result')).toBeDefined()
      expect(
        [
          ...new Set(
            [...writerTools.tools, ...readerTools.tools]
              .filter((tool) => tool.annotations?.readOnlyHint === true)
              .map((tool) => tool.name),
          ),
        ].sort(),
      ).toEqual(['check_orchestrator_messages', 'gate_result'])

      const result = await writerConnection.client.callTool({ name: 'run_gate', arguments: {} })
      expect(result.isError).toBeUndefined()
      expect(resultText(result)).toBe(
        "This run's project has no registered gate, so nothing was run.",
      )
      const readerResult = await readerConnection.client.callTool({
        name: 'gate_result',
        arguments: {},
      })
      expect(readerResult.isError).toBeUndefined()
      expect(resultText(readerResult)).toBe(
        "No finished gate result is recorded. The writer's gate and the pre-merge local gate are the proof.",
      )
      expect(
        (
          db().query('SELECT COUNT(*) AS n FROM gate_execution WHERE run_id=?').get(writer) as {
            n: number
          }
        ).n,
      ).toBe(0)
    } finally {
      await writerConnection.close()
      await readerConnection.close()
    }
  })

  test('run_gate returns at its bound, then rejoins the same execution for its result', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const project = db()
      .query(`INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?) RETURNING id`)
      .get('gate-wait-fixture', '/fixture', 'bun', JSON.stringify({ gate: 'bun run check' })) as {
      id: number
    }
    db().query('UPDATE run SET project_id=? WHERE id=?').run(project.id, run)
    let nowMs = Date.now()
    let waits = 0
    const connection = await askClient(run, '', undefined, {
      fileWorkerNote: async () => ({ noteId: 1, candidateIds: [] }),
      gate: {
        waitMs: 2,
        now: () => nowMs,
        wait: async () => {
          nowMs += 2
          waits += 1
          if (waits === 2) {
            db()
              .query(
                `UPDATE gate_execution
                    SET finished_at=?,exit_code=0,timed_out=0,elapsed_ms=4,output_tail='passed'
                  WHERE run_id=?`,
              )
              .run(new Date(nowMs).toISOString(), run)
          }
        },
      },
    })
    try {
      const first = await connection.client.callTool({ name: 'run_gate', arguments: {} })
      expect(first.isError).toBeUndefined()
      expect(resultText(first)).toContain('The gate is still running after')
      expect(resultText(first)).toContain('ms.')
      expect(resultText(first)).toContain('Call run_gate again to wait for this same execution')

      const second = await connection.client.callTool({ name: 'run_gate', arguments: {} })
      expect(second.isError).toBeUndefined()
      expect(resultText(second)).toContain('Gate exit code: 0')
      expect(resultText(second)).toContain('passed')
      expect(
        (
          db().query('SELECT COUNT(*) AS n FROM gate_execution WHERE run_id=?').get(run) as {
            n: number
          }
        ).n,
      ).toBe(1)
    } finally {
      await connection.close()
    }
  })

  test('an aborted run_gate call leaves its result pending for the next call', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const project = db()
      .query(`INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?) RETURNING id`)
      .get('gate-abort-fixture', '/fixture', 'bun', JSON.stringify({ gate: 'bun run check' })) as {
      id: number
    }
    db().query('UPDATE run SET project_id=? WHERE id=?').run(project.id, run)
    const controller = new AbortController()
    let waitCalls = 0
    const connection = await askClient(run, '', undefined, {
      fileWorkerNote: async () => ({ noteId: 1, candidateIds: [] }),
      gate: {
        waitMs: 10,
        now: Date.now,
        wait: async () => {
          waitCalls += 1
          controller.abort()
          db()
            .query(
              `UPDATE gate_execution
                  SET finished_at=?,exit_code=0,timed_out=0,elapsed_ms=4,output_tail='passed after abort'
                WHERE run_id=?`,
            )
            .run(new Date().toISOString(), run)
        },
      },
    })
    try {
      await expect(
        connection.client.callTool(
          { name: 'run_gate', arguments: {} },
          { signal: controller.signal },
        ),
      ).rejects.toThrow()
      await Bun.sleep(10)

      const second = await connection.client.callTool({ name: 'run_gate', arguments: {} })
      expect(second.isError).toBeUndefined()
      expect(resultText(second)).toContain('Gate exit code: 0')
      expect(resultText(second)).toContain('passed after abort')
      expect(waitCalls).toBe(1)
      expect(
        (
          db().query('SELECT COUNT(*) AS n FROM gate_execution WHERE run_id=?').get(run) as {
            n: number
          }
        ).n,
      ).toBe(1)
    } finally {
      await connection.close()
    }
  })

  test('gate_result returns the newest finished gate for the reader project and exact commit', async () => {
    const project = db()
      .query(
        `INSERT INTO project (name,path,stack,settings) VALUES ('gate-result-fixture','/fixture','bun','{}') RETURNING id`,
      )
      .get() as { id: number }
    const reader = addRun({
      agent: 'codex',
      job: 'review-lens',
      status: 'running',
      headCommit: 'reviewed-commit',
    })
    const olderWriter = addRun({ agent: 'codex', job: 'implement', headCommit: 'reviewed-commit' })
    const newerWriter = addRun({ agent: 'codex', job: 'implement', headCommit: 'reviewed-commit' })
    const otherWriter = addRun({ agent: 'codex', job: 'implement', headCommit: 'other-commit' })
    for (const run of [reader, olderWriter, newerWriter, otherWriter]) {
      db().query('UPDATE run SET project_id=? WHERE id=?').run(project.id, run)
    }
    db()
      .query(
        `INSERT INTO gate_execution
          (run_id,requested_at,finished_at,exit_code,timed_out,elapsed_ms,output_tail,head_commit)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        olderWriter,
        '2026-10-01T10:00:00.000Z',
        '2026-10-01T10:01:00.000Z',
        1,
        0,
        60_000,
        'older failure',
        'reviewed-commit',
      )
    db()
      .query(
        `INSERT INTO gate_execution
          (run_id,requested_at,finished_at,exit_code,timed_out,elapsed_ms,output_tail,head_commit)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        newerWriter,
        '2026-10-01T11:00:00.000Z',
        '2026-10-01T11:01:00.000Z',
        0,
        0,
        61_000,
        'newest success',
        'reviewed-commit',
      )
    db()
      .query(
        `INSERT INTO gate_execution
          (run_id,requested_at,finished_at,exit_code,timed_out,elapsed_ms,output_tail,head_commit)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        otherWriter,
        '2026-10-01T12:00:00.000Z',
        '2026-10-01T12:01:00.000Z',
        0,
        0,
        62_000,
        'wrong commit',
        'other-commit',
      )

    const connection = await askClient(reader)
    try {
      const result = await connection.client.callTool({ name: 'gate_result', arguments: {} })
      expect(result.isError).toBeUndefined()
      expect(resultText(result)).toBe(
        [
          'Recorded gate result for commit reviewed-commit:',
          "This result was recorded by the project's writer gate or by orch gate run for that commit.",
          `executing run id: ${newerWriter}`,
          'exit code: 0',
          'timed out: false',
          'elapsed ms: 61000',
          'finished at: 2026-10-01T11:01:00.000Z',
          'output tail:',
          'newest success',
        ].join('\n'),
      )
    } finally {
      await connection.close()
    }
  })

  test('a live question is answerable through the command, not only in SQL', () => {
    const live = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db()
      .query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(live, new Date().toISOString(), 'which table?')
    const answerable = (id: number) => {
      const r = db().query('SELECT status, parent_run_id FROM run WHERE id = ?').get(id) as {
        status: string
        parent_run_id: number | null
      }
      const open = db()
        .query(
          `SELECT COUNT(*) n FROM question q JOIN run r ON r.id = q.run_id
          WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
        )
        .get(id, id) as { n: number }
      return !r.parent_run_id && open.n > 0 && (r.status === 'running' || r.status === 'asking')
    }
    expect(answerable(live)).toBe(true)
    expect(answerable(addRun({ agent: 'codex', job: 'implement', status: 'running' }))).toBe(false)
  })
  test('a question asked on turn two is answerable from the root', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
    db()
      .query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(child, new Date().toISOString(), 'and now what?')
    const open = db()
      .query(
        `SELECT q.id FROM question q JOIN run r ON r.id = q.run_id
        WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
      )
      .all(root, root) as { id: number }[]
    expect(open.length).toBe(1)
  })
  test('an unanswered question survives the timeout', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    await ask({ runId: run, question: 'still open', timeoutMs: 50 })
    const open = db()
      .query('SELECT asked_via FROM question WHERE run_id = ? AND answered_at IS NULL')
      .get(run)
    expect(open).toEqual({ asked_via: 'live' })
    expect(db().query('SELECT kind FROM outbox ORDER BY id').all()).toEqual([
      { kind: 'run' },
      { kind: 'question' },
    ])
  })

  test('missing required text instructs the worker without recording or returning an error', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const { client, close } = await askClient(run)
    try {
      const tools = await client.listTools()
      const askTool = tools.tools.find((tool) => tool.name === 'ask_orchestrator')
      const messageTool = tools.tools.find((tool) => tool.name === 'message_orchestrator')
      expect(askTool?.inputSchema.required).toContain('question')
      expect(messageTool?.inputSchema.required).toContain('body')

      const question = await client.callTool({ name: 'ask_orchestrator', arguments: {} })
      expect(question.isError).toBeUndefined()
      expect(resultText(question)).toContain('Call ask_orchestrator again')
      expect(resultText(question)).toContain('Do not decide the matter yourself')

      const message = await client.callTool({ name: 'message_orchestrator', arguments: {} })
      expect(message.isError).toBeUndefined()
      expect(resultText(message)).toContain('Call message_orchestrator again')
      expect(
        (
          db().query('SELECT COUNT(*) AS n FROM question WHERE run_id = ?').get(run) as {
            n: number
          }
        ).n,
      ).toBe(0)
      expect(
        (
          db().query('SELECT COUNT(*) AS n FROM run_message WHERE run_id = ?').get(run) as {
            n: number
          }
        ).n,
      ).toBe(0)
    } finally {
      await close()
    }
  })

  test('note derives run identity and reports the filed and candidate ids', async () => {
    const run = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
    const project = db()
      .query(`INSERT INTO project (name,path,settings) VALUES (?,?,?) RETURNING id,name`)
      .get('worker-note-project', '/projects/worker-note', '{}') as { id: number; name: string }
    db()
      .query(
        `UPDATE run SET project_id=?,worktree=?,branch=?,session_id=?,head_commit=? WHERE id=?`,
      )
      .run(project.id, '/runs/review-tree', 'DEV-1029-review', 'session-1029', 'abc123', run)
    const seen: unknown[] = []
    const connection = await askClient(run, '', undefined, {
      fileWorkerNote: async (derived, input) => {
        seen.push(derived, input)
        return {
          noteId: 71,
          candidateIds: [8, 13],
          anchorDropped:
            'File anchor src/file.ts:3 was dropped because the line is new or changed on the branch.',
        }
      },
    })
    try {
      const refused = await connection.client.callTool({
        name: 'note',
        arguments: { text: 'first\nsecond' },
      })
      expect(refused.isError).toBe(true)
      expect(resultText(refused)).toContain('must be a single line')
      expect(seen).toEqual([])

      const result = await connection.client.callTool({
        name: 'note',
        arguments: { text: 'outside defect', file: 'src/file.ts:3' },
      })
      expect(result.isError).toBeUndefined()
      expect(resultText(result)).toBe(
        'Note 71 filed. Near-duplicate candidate ids: 8, 13. File anchor src/file.ts:3 was dropped because the line is new or changed on the branch.',
      )
      expect(seen).toEqual([
        {
          id: run,
          project: project.name,
          projectPath: '/projects/worker-note',
          tree: '/runs/review-tree',
          branch: 'DEV-1029-review',
          sessionId: 'session-1029',
          headCommit: 'abc123',
        },
        { text: 'outside defect', file: 'src/file.ts:3' },
      ])
    } finally {
      await connection.close()
    }
  })

  test('ask returns ordinary replies when it times out or cannot record', async () => {
    const timedOutRun = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const timeoutConnection = await askClient(timedOutRun, '', 0)
    try {
      const result = await timeoutConnection.client.callTool({
        name: 'ask_orchestrator',
        arguments: { question: 'Which design?' },
      })
      expect(result.isError).toBeUndefined()
      expect(resultText(result)).toContain('No ruling arrived within the time limit')
    } finally {
      await timeoutConnection.close()
    }

    const failedRun = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().exec(
      "CREATE TEMP TRIGGER fail_question BEFORE INSERT ON question BEGIN SELECT RAISE(FAIL, 'fixture recording failure'); END",
    )
    const failureConnection = await askClient(failedRun)
    try {
      const result = await failureConnection.client.callTool({
        name: 'ask_orchestrator',
        arguments: { question: 'Which design?' },
      })
      expect(result.isError).toBeUndefined()
      expect(resultText(result)).toContain('fixture recording failure')
      expect(resultText(result)).toContain('Do not decide it yourself')
    } finally {
      await failureConnection.close()
      db().exec('DROP TRIGGER fail_question')
    }
  })

  test('every tool gives an unauthorized caller blocked-status guidance', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query('UPDATE run SET run_token = ? WHERE id = ?').run('right-token', run)
    const { client, close } = await askClient(run, 'wrong-token')
    try {
      const question = await client.callTool({
        name: 'ask_orchestrator',
        arguments: { question: 'Which design?' },
      })
      const message = await client.callTool({
        name: 'message_orchestrator',
        arguments: { body: 'Progress' },
      })
      const check = await client.callTool({
        name: 'check_orchestrator_messages',
        arguments: {},
      })

      expect(question.isError).toBeUndefined()
      expect(message.isError).toBe(true)
      expect(check.isError).toBe(true)
      for (const result of [question, message, check]) {
        expect(resultText(result)).toContain('Return status "blocked" with your question')
      }
    } finally {
      await close()
    }
  })

  test('message and check expose operation failures as tool errors', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const { client, close } = await askClient(run)
    try {
      const message = await client.callTool({
        name: 'message_orchestrator',
        arguments: { body: 'Progress' },
      })
      const check = await client.callTool({
        name: 'check_orchestrator_messages',
        arguments: {},
      })
      expect(message.isError).toBe(true)
      expect(resultText(message)).toContain('is asking, not running')
      expect(check.isError).toBe(true)
      expect(resultText(check)).toContain('is asking, not running')
    } finally {
      await close()
    }
  })
})
