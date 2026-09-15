import { describe, expect, test } from 'bun:test'
import { addRun } from '../test/fixtures/store.ts'
import { db } from './db.ts'
import { checkMessages, messageArchitect, messagesForRun } from './mailbox.ts'
import { receiptMessagesForArchitect, tellRun } from './mailbox.ts'

describe('run mailbox', () => {
  const mailboxOrchInput = (
    args: string[],
    stdin?: string | Uint8Array,
    extraEnv: Record<string, string> = {},
  ) => {
    const prior = Object.fromEntries(
      Object.keys(extraEnv)
        .concat('CLAUDE_CODE_SESSION_ID')
        .map((key) => [key, process.env[key]]),
    )
    process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
    Object.assign(process.env, extraEnv)
    try {
      if (args[0] === 'tell') {
        const message = tellRun(Number(args[1]), args.slice(2).join(' '))
        return { code: 0, out: `queued message ${message.id}; it has not been read`, err: '' }
      }
      if (args[0] === 'run') {
        const rows = args.includes('--receipt')
          ? receiptMessagesForArchitect(Number(args[1]))
          : messagesForRun(Number(args[1]))
        return { code: 0, out: JSON.stringify({ messages: rows }), err: '' }
      }
      if (args[0] === 'ask-server') {
        const runId = Number(extraEnv.ORCH_RUN_ID)
        if (!runId)
          return {
            code: 0,
            out:
              JSON.stringify({
                result: {
                  isError: true,
                  content: [{ text: 'this process is not a recognised orchestrator worker' }],
                },
              }) + '\n',
            err: '',
          }
        const requests = String(stdin)
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        const replies = requests.map((request) => {
          if (request.params.name === 'message_orchestrator') {
            messageArchitect(runId, request.params.arguments.body)
            return { result: { content: [{ text: 'Keep working' }] } }
          }
          const rows = checkMessages(runId)
          return {
            result: {
              content: [
                {
                  text: `[message] ${rows.map((row) => row.body).join(' ')} non-authoritative context`,
                },
              ],
            },
          }
        })
        return {
          code: 0,
          out: replies.map((reply) => JSON.stringify(reply)).join('\n') + '\n',
          err: '',
        }
      }
      throw new Error(`unsupported test command ${args[0]}`)
    } catch (cause) {
      return { code: 1, out: '', err: cause instanceof Error ? cause.message : String(cause) }
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
  const mailboxOrch = (...args: string[]) => mailboxOrchInput(args)
  test('queues inbound context and receipts it only when the worker checks', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db()
      .query('UPDATE run SET vendor_session=?, run_token=? WHERE id=?')
      .run('worker-session', 'token', root)

    const told = mailboxOrch('tell', String(root), 'keep the public shape unchanged')
    expect(told.code).toBe(0)
    const queued = messagesForRun(root)[0]!
    expect(queued).toMatchObject({
      direction: 'to_worker',
      root_run_id: root,
      run_id: root,
      body: 'keep the public shape unchanged',
      read_at: null,
      read_by: null,
      delivery: 'architect_cli',
    })

    const read = checkMessages(root)
    expect(read).toHaveLength(1)
    expect(read[0]!.read_at).not.toBeNull()
    expect(read[0]!.read_by).toBe('worker-session')
    expect(checkMessages(root)).toEqual([])
  })
  test('tell authorizes against the root and records the permitted sender', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const child = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'running',
      parent: root,
      turn: 2,
    })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('owner-session', root)
    db().query('UPDATE run SET session_id=? WHERE id=?').run('foreign-session', child)

    const foreign = mailboxOrchInput(['tell', String(child), 'foreign steering'], undefined, {
      CLAUDE_CODE_SESSION_ID: 'foreign-session',
    })
    expect(foreign.code).toBe(1)
    expect(messagesForRun(root)).toEqual([])

    const owner = mailboxOrchInput(['tell', String(child), 'owner context'], undefined, {
      CLAUDE_CODE_SESSION_ID: 'owner-session',
    })
    expect(owner.code).toBe(0)
    expect(messagesForRun(root)[0]!.sender_session).toBe('owner-session')
    expect(
      db().query('SELECT action, actor_session FROM run_mutation_audit WHERE run_id=?').get(child),
    ).toEqual({ action: 'tell', actor_session: 'owner-session' })
  })
  test('the first tell adopts an unowned root and refuses a second session', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query('UPDATE run SET session_id=NULL WHERE id=?').run(root)

    const first = mailboxOrchInput(['tell', String(root), 'session A context'], undefined, {
      CLAUDE_CODE_SESSION_ID: 'session-A',
    })
    expect(first.code).toBe(0)
    expect(db().query('SELECT session_id FROM run WHERE id=?').get(root)).toEqual({
      session_id: 'session-A',
    })

    const second = mailboxOrchInput(
      ['tell', String(root), 'conflicting session B context'],
      undefined,
      {
        CLAUDE_CODE_SESSION_ID: 'session-B',
      },
    )
    expect(second.code).toBe(1)
    expect(
      messagesForRun(root).map((message) => ({
        body: message.body,
        sender: message.sender_session,
      })),
    ).toEqual([{ body: 'session A context', sender: 'session-A' }])
    expect(
      db()
        .query(
          `SELECT action, actor_session, reason FROM run_mutation_audit
        WHERE root_id=? ORDER BY rowid`,
        )
        .all(root),
    ).toEqual([
      { action: 'adopt', actor_session: 'session-A', reason: 'before tell' },
      { action: 'tell', actor_session: 'session-A', reason: null },
    ])
  })
  test('an unread note stays queued and cannot close an open question', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db()
      .query(
        `INSERT INTO question (run_id, asked_at, question)
       VALUES (?, ?, 'which interface?')`,
      )
      .run(root, new Date().toISOString())

    expect(mailboxOrch('tell', String(root), 'background context only').code).toBe(0)
    expect(messagesForRun(root)[0]!.read_at).toBeNull()
    expect(db().query('SELECT answer, answered_at FROM question WHERE run_id=?').get(root)).toEqual(
      { answer: null, answered_at: null },
    )
    expect(
      (db().query('SELECT status FROM run WHERE id=?').get(root) as { status: string }).status,
    ).toBe('running')
  })
  test('run detail is read-only; only the root owner can explicitly receipt worker messages', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const child = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'running',
      parent: root,
      turn: 2,
    })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('session-A', root)
    db()
      .query('UPDATE run SET session_id=?, vendor_session=? WHERE id=?')
      .run('session-B', 'worker-session', child)

    const sent = messageArchitect(child, 'the implementation is taking a narrower shape')
    expect(sent).toMatchObject({
      direction: 'from_worker',
      root_run_id: root,
      run_id: child,
      sender_session: 'worker-session',
      read_at: null,
      read_by: null,
      delivery: 'worker_tool',
    })

    mailboxOrchInput(['run', String(child)], undefined, {
      CLAUDE_CODE_SESSION_ID: 'session-B',
    })
    expect(messagesForRun(root)[0]).toMatchObject({ read_at: null, read_by: null })

    const foreign = mailboxOrchInput(['run', String(child), '--receipt'], undefined, {
      CLAUDE_CODE_SESSION_ID: 'session-B',
    })
    expect(foreign.code).toBe(1)
    expect(messagesForRun(root)[0]).toMatchObject({ read_at: null, read_by: null })

    const owner = mailboxOrchInput(['run', String(child), '--receipt'], undefined, {
      CLAUDE_CODE_SESSION_ID: 'session-A',
    })
    expect(owner.code).toBe(0)
    expect(messagesForRun(root)[0]!.read_at).not.toBeNull()
    expect(messagesForRun(root)[0]!.read_by).toBe('session-A')
    expect(db().query('SELECT COUNT(*) n FROM run_mutation_audit').get()).toEqual({ n: 0 })
  }, 20_000)
  test('bridge-only identity cannot receipt an unowned run', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    messageArchitect(root, 'the implementation is taking a narrower shape')
    const result = mailboxOrchInput(['run', String(root), '--receipt'], undefined, {
      CLAUDE_CODE_SESSION_ID: '',
      CLAUDE_CODE_BRIDGE_SESSION_ID: 'shared-bridge',
    })
    expect(result.code).toBe(1)
    expect(messagesForRun(root)[0]).toMatchObject({ read_at: null, read_by: null })
    expect(db().query('SELECT session_id FROM run WHERE id=?').get(root)).toEqual({
      session_id: null,
    })
    expect(db().query('SELECT COUNT(*) n FROM run_mutation_audit').get()).toEqual({ n: 0 })
  })
  test('the worker MCP tools send outbound and read inbound at a checkpoint', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db()
      .query('UPDATE run SET vendor_session=?, run_token=? WHERE id=?')
      .run('worker-session', 'mailbox-token', root)
    expect(mailboxOrch('tell', String(root), 'new context').code).toBe(0)
    const calls =
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'message_orchestrator',
            arguments: { body: 'progress without stopping' },
          },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'check_orchestrator_messages',
            arguments: {},
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n'
    const result = mailboxOrchInput(['ask-server'], calls, {
      ORCH_RUN_ID: String(root),
      ORCH_RUN_TOKEN: 'mailbox-token',
    })
    expect(result.code).toBe(0)
    expect(messagesForRun(root)).toHaveLength(2)
    expect(
      messagesForRun(root).find((message) => message.direction === 'to_worker')!.read_at,
    ).not.toBeNull()
    expect(
      (db().query('SELECT status FROM run WHERE id=?').get(root) as { status: string }).status,
    ).toBe('running')
  })
  test('a resumed turn reads tell queued after the first turn ended', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'running',
      parent: root,
      turn: 2,
    })
    db()
      .query('UPDATE run SET vendor_session=?, run_token=? WHERE id=?')
      .run('first-turn-session', 'root-token', root)
    db()
      .query('UPDATE run SET vendor_session=?, run_token=? WHERE id=?')
      .run('resume-session', 'turn-token', child)
    expect(mailboxOrch('tell', String(root), 'note after turn one').code).toBe(0)
    expect(messagesForRun(root)[0]!.read_at).toBeNull()

    const unrecognised = mailboxOrchInput(
      ['ask-server'],
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'check_orchestrator_messages',
          arguments: {},
        },
      }) + '\n',
      { ORCH_RUN_ID: '', ORCH_RUN_TOKEN: '' },
    )
    expect(unrecognised.code).toBe(0)
    expect(messagesForRun(root)[0]!.read_at).toBeNull()

    const resumed = mailboxOrchInput(
      ['ask-server'],
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'check_orchestrator_messages',
          arguments: {},
        },
      }) + '\n',
      { ORCH_RUN_ID: String(child), ORCH_RUN_TOKEN: 'turn-token' },
    )
    expect(resumed.code).toBe(0)
    expect(messagesForRun(root)[0]!.read_at).not.toBeNull()
    expect(messagesForRun(root)[0]!.read_by).toBe('resume-session')
  })
  test('tell targets the active child turn while retaining the conversation root', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'running',
      parent: root,
      turn: 2,
    })
    expect(mailboxOrch('tell', String(root), 'context for turn two').code).toBe(0)
    expect(messagesForRun(child)[0]).toMatchObject({ root_run_id: root, run_id: child })
  })
  test('tell refuses a finished conversation instead of claiming a queue', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
    const told = mailboxOrch('tell', String(root), 'too late')
    expect(told.code).toBe(1)
    expect(messagesForRun(root)).toEqual([])
  })
})
