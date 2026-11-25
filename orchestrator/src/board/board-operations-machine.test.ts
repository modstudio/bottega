import { expect, test } from 'bun:test'
import { hostname } from 'node:os'
import { newRecordId } from '../../../shared/record-id.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { sessionHold } from '../session/session-hold.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'
import {
  boardAccept,
  boardAcknowledge,
  boardAsk,
  boardFileNote,
  boardPost,
  boardReply,
  boardStatus,
  boardThread,
  boardWithdraw,
} from './board-operations.ts'
import { replyToThread } from './board-thread-service.ts'

test('machine writes and their number and UUID reads stay local after adoption', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const client = createMemoryRecordApiClient()
  const env = { BOTTEGA_RECORD_API_URL: 'https://record.test' }
  const local = await boardPost(
    { audience: 'machine:host', title: 'Machine', body: 'local' },
    { env, client },
  )
  expect(local.recordId).toMatch(/^[0-9a-f-]{36}$/)
  await expect(boardThread(local.recordId, { env, client })).resolves.toMatchObject({
    root: { recordId: local.recordId },
  })
  await expect(boardStatus(local.recordId, { env, client })).resolves.toMatchObject({
    message: { recordId: local.recordId },
  })
  await expect(boardStatus(String(local.number), { env, client })).resolves.toMatchObject({
    message: { recordId: local.recordId },
  })
})

test('every message-id verb resolves machine-scoped numbers and UUIDs locally after adoption', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const session = 'machine-message-id-reader'
  const clock = Date.now()
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect',?,'machine-project',NULL,'/tmp',NULL,?,?)`,
    )
    .run(session, hostname(), new Date(clock - 2_000).toISOString(), new Date(clock).toISOString())
  const operatorEnv = { BOTTEGA_RECORD_API_URL: 'https://record.test' }
  const readerEnv = { ...operatorEnv, CLAUDE_CODE_SESSION_ID: session }
  let hostedCalls = 0
  const client = new Proxy(createMemoryRecordApiClient(), {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return () => {
        hostedCalls += 1
        throw new Error(`hosted client method ${String(property)} was called`)
      }
    },
  })
  let fixture = 0
  const clearMessages = () => {
    db().query('DELETE FROM session_board_hold').run()
    db().query('DELETE FROM board_receipt').run()
    db().query('DELETE FROM board_message').run()
  }
  const machineNotice = async (ackRequired = false) => {
    fixture += 1
    return boardPost(
      {
        audience: `machine:${hostname()}`,
        title: `Machine notice ${fixture}`,
        body: `Machine notice body ${fixture}`,
        purpose: ackRequired ? 'request' : 'information',
        ackRequired,
      },
      { env: operatorEnv, client, clock: clock + fixture },
    )
  }
  const machineQuestion = async () => {
    fixture += 1
    const question = await boardAsk(
      {
        audience: `machine:${hostname()}`,
        title: `Machine question ${fixture}`,
        body: `Machine question body ${fixture}`,
      },
      { env: operatorEnv, client, clock: clock + fixture },
    )
    const reply = replyToThread(
      question.recordId,
      `Machine answer ${fixture}`,
      operatorEnv,
      clock + fixture + 1,
    )
    return { question, reply }
  }
  const id = (row: { recordId: string; number: number | null }, form: 'number' | 'uuid') =>
    form === 'number' ? String(row.number) : row.recordId
  const filer = async () => ({ noteRecordId: newRecordId(), noteLabel: 'machine-note#1' })
  const operations = [
    {
      name: 'boardReply',
      run: async (form: 'number' | 'uuid') => {
        const { question } = await machineQuestion()
        await boardReply(id(question, form), 'A second machine answer', {
          env: operatorEnv,
          client,
          clock: clock + fixture + 2,
        })
      },
    },
    {
      name: 'boardThread',
      run: async (form: 'number' | 'uuid') => {
        const notice = await machineNotice()
        await boardThread(id(notice, form), { env: operatorEnv, client })
      },
    },
    {
      name: 'boardAccept',
      run: async (form: 'number' | 'uuid') => {
        const { question, reply } = await machineQuestion()
        await boardAccept(id(question, form), id(reply, form), {
          env: operatorEnv,
          client,
          answerNoteFiler: filer,
        })
      },
    },
    {
      name: 'boardFileNote',
      run: async (form: 'number' | 'uuid') => {
        const { question, reply } = await machineQuestion()
        db()
          .query(
            `UPDATE board_message SET accepted_reply_record_id=?,accepted_by='operator',accepted_at=?
             WHERE record_id=?`,
          )
          .run(reply.recordId, new Date(clock).toISOString(), question.recordId)
        await boardFileNote(id(question, form), {
          env: operatorEnv,
          client,
          answerNoteFiler: filer,
        })
      },
    },
    {
      name: 'boardWithdraw',
      run: async (form: 'number' | 'uuid') => {
        const notice = await machineNotice()
        await boardWithdraw(id(notice, form), { env: operatorEnv, client })
      },
    },
    {
      name: 'boardAcknowledge',
      run: async (form: 'number' | 'uuid') => {
        const notice = await machineNotice(true)
        await boardAcknowledge(id(notice, form), { env: readerEnv, client })
      },
    },
    {
      name: 'boardStatus',
      run: async (form: 'number' | 'uuid') => {
        const notice = await machineNotice()
        await boardStatus(id(notice, form), { env: operatorEnv, client })
      },
    },
    {
      name: 'sessionHold',
      run: async (form: 'number' | 'uuid') => {
        const notice = await machineNotice()
        await sessionHold({ on: id(notice, form) }, { env: readerEnv, recordId: newRecordId })
      },
    },
  ] as const

  expect(operations.map((operation) => operation.name)).toEqual([
    'boardReply',
    'boardThread',
    'boardAccept',
    'boardFileNote',
    'boardWithdraw',
    'boardAcknowledge',
    'boardStatus',
    'sessionHold',
  ])
  for (const form of ['number', 'uuid'] as const) {
    for (const operation of operations) {
      clearMessages()
      await operation.run(form)
    }
  }
  expect(hostedCalls).toBe(0)
})
