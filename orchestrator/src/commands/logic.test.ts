import { expect, spyOn, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { db, sessionId } from '../database/db.ts'
import { register } from './logic.ts'
import { register as registerRunTaskLinking } from './run-task-linking.ts'
import { setRawArgv } from './support.ts'

const trackResidue = trackedTestResidue()

const bindRunToCursor = (runId: string): void => {
  db()
    .query("UPDATE run SET cursor_record_id=?,step_slug='test-step' WHERE record_id=?")
    .run(newRecordId(), runId)
}

test('agent registration forwards provider mutations to the agent command', async () => {
  const received: string[][] = []
  const parse = async (argv: string[]) => {
    const program = new Command().exitOverride()
    register(program, {
      agentCommand: async (receivedArgv) => {
        received.push(receivedArgv)
      },
    })
    await program.parseAsync(['node', 'orch', ...argv])
  }

  await parse(['agent', 'set', 'metered', '--provider', 'openrouter'])
  await parse(['agent', 'set', 'metered', '--clear-provider'])
  await parse(['agent', 'set', 'metered', '--request-settings', '{"reasoning":{"effort":"low"}}'])
  await parse(['agent', 'set', 'metered', '--clear-request-settings'])

  expect(received).toEqual([
    ['agent', 'set', 'metered', '--provider', 'openrouter'],
    ['agent', 'set', 'metered', '--clear-provider'],
    ['agent', 'set', 'metered', '--request-settings', '{"reasoning":{"effort":"low"}}'],
    ['agent', 'set', 'metered', '--clear-request-settings'],
  ])
})

test('answer refuses a question-sibling option instead of recording it as ruling text', async () => {
  const recordId = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: sessionId(),
  })
  db()
    .query(
      `INSERT INTO question (record_id,number,run_record_id,asked_at,question)
       VALUES (?,1849,?,'2026-10-28','Which option?')`,
    )
    .run(newRecordId(), recordId)
  const number = (
    db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as { number: number }
  ).number
  const program = new Command().exitOverride()
  register(program)
  const argv = ['node', 'orch', 'answer', String(number), '--cwd=/tmp/other-tree']
  setRawArgv(argv.slice(2))

  await expect(program.parseAsync(argv)).rejects.toThrow(
    `--cwd is not an option of question answer; see ${PLATFORM_SLUG} question --help`,
  )
})

test('answer honors a typed value before or after the positional run id', async () => {
  const answerValueFor = async (valueBeforeId: boolean) => {
    const recordId = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'asking',
      session: sessionId(),
    })
    bindRunToCursor(recordId)
    const number = db()
      .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
      .get(recordId)!.number
    db()
      .query(
        `INSERT INTO question
          (record_id,number,run_record_id,asked_at,question,kind,typed_options)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM question),?,'2026-11-21',
                 'Which option?','choice',?)`,
      )
      .run(newRecordId(), recordId, JSON.stringify([{ name: 'Use task comment' }, { name: 'Ask' }]))
    const program = new Command().exitOverride()
    register(program)
    const argv = valueBeforeId
      ? [
          'node',
          'orch',
          'answer',
          '--value',
          'Use task comment',
          '--record-only',
          String(number),
          'Use the task comment.',
        ]
      : [
          'node',
          'orch',
          'answer',
          String(number),
          '--value',
          'Use task comment',
          '--record-only',
          'Use the task comment.',
        ]
    setRawArgv(argv.slice(2))
    await program.parseAsync(argv)
    return db()
      .query<{ answer_value: string }, [string]>(
        'SELECT answer_value FROM question WHERE run_record_id=?',
      )
      .get(recordId)!.answer_value
  }

  expect(await answerValueFor(true)).toBe('"Use task comment"')
  expect(await answerValueFor(false)).toBe('"Use task comment"')
})

test('answer records a late ruling on a closed cursor question without moving its cursor', async () => {
  const suffix = newRecordId().slice(-8)
  const project = `late-ruling-${suffix}`
  const projectId = newRecordId()
  const cursorId = newRecordId()
  const questionId = newRecordId()
  const questionNumber = 910_000 + Number.parseInt(suffix.slice(0, 4), 16)
  db().exec('PRAGMA foreign_keys=OFF')
  db()
    .query('INSERT INTO project(record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(projectId, project, `/tmp/${project}`, '{}')
  db()
    .query(
      `INSERT OR REPLACE INTO presence
         (session_id,harness,role,machine,project,project_record_id,cwd,first_seen,last_seen)
       VALUES (?,'codex','architect','machine',?,?,?,'2026-11-17','2026-11-17')`,
    )
    .run(sessionId(), project, projectId, `/tmp/${project}`)
  db()
    .query(
      `INSERT INTO workflow_cursor
        (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
         session_id,workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,
         closed,question,total_steps,created_at,updated_at,revision)
       VALUES (?,9987,?,?,'flow','default','DEV-2394','',?, ?,?,'{}',2,'review','running',
               '[]',NULL,4,'2026-11-17','2026-11-17',7)`,
    )
    .run(cursorId, project, projectId, sessionId(), newRecordId(), newRecordId())
  db()
    .query(
      `INSERT INTO question
        (record_id,number,workflow_cursor_record_id,asked_at,question,asked_via,
         closed_at,close_reason)
       VALUES (?,?,?,'2026-11-17','Proceed?','workflow','2026-11-17','advanced-without-ruling')`,
    )
    .run(questionId, questionNumber, cursorId)
  db().exec('PRAGMA foreign_keys=ON')

  const program = new Command().exitOverride()
  register(program)
  const argv = ['node', 'orch', 'answer', `q${questionNumber}`, '--json', 'late ruling']
  setRawArgv(argv.slice(2))
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    await program.parseAsync(argv)
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ outcome: 'recorded-late', question_record_id: questionId }),
    )
  } finally {
    log.mockRestore()
  }

  const answered = db()
    .query('SELECT answer,answered_at,closed_at,close_reason FROM question WHERE record_id=?')
    .get(questionId) as Record<string, unknown>
  expect(answered).toMatchObject({
    answer: 'late ruling',
    closed_at: '2026-11-17T00:00:00.000Z',
    close_reason: 'advanced-without-ruling',
  })
  expect(typeof answered.answered_at).toBe('string')
  expect(
    db()
      .query('SELECT ordinal,step_slug,state,revision FROM workflow_cursor WHERE record_id=?')
      .get(cursorId),
  ).toEqual({ ordinal: 2, step_slug: 'review', state: 'running', revision: 7 })
})

test('tell refuses a run-sibling option instead of queuing it as message text', async () => {
  const recordId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const number = (
    db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as { number: number }
  ).number
  const program = new Command().exitOverride()
  register(program)
  const argv = ['node', 'orch', 'tell', String(number), '--json=1']
  setRawArgv(argv.slice(2))

  await expect(program.parseAsync(argv)).rejects.toThrow(
    `--json is not an option of run tell; see ${PLATFORM_SLUG} run --help`,
  )
})

test('tell derives refusals from newly registered owner options', async () => {
  const recordId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const number = (
    db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as { number: number }
  ).number
  const program = new Command().exitOverride()
  register(program)
  registerRunTaskLinking(program)
  const argv = ['node', 'orch', 'tell', String(number), '--dry-run']
  setRawArgv(argv.slice(2))

  await expect(program.parseAsync(argv)).rejects.toThrow(
    `--dry-run is not an option of run tell; see ${PLATFORM_SLUG} run --help`,
  )
})

test('relay honors its note option before the positional run id', async () => {
  const recordId = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: sessionId(),
  })
  const questionId = newRecordId()
  db()
    .query(
      `INSERT INTO question (record_id,number,run_record_id,asked_at,question)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM question),?,'2026-11-21','Which option?')`,
    )
    .run(questionId, recordId)
  const number = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(recordId)!.number
  const program = new Command().exitOverride()
  register(program)
  const argv = ['node', 'orch', 'relay', '--note', 'Needs operator judgment', String(number)]
  setRawArgv(argv.slice(2))

  await program.parseAsync(argv)

  expect(
    db()
      .query('SELECT awaiting_operator_at,relayed_by FROM question WHERE record_id=?')
      .get(questionId),
  ).toMatchObject({
    awaiting_operator_at: expect.any(String),
    relayed_by: expect.any(String),
  })
})

test('continue parses --findings before the message and hands the rendered text to continuation', async () => {
  const recordId = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  bindRunToCursor(recordId)
  const number = (
    db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as {
      number: number
    }
  ).number
  const program = new Command().exitOverride()
  let received: string | undefined
  register(program, {
    continuationFindingsForRun: (_database, runId, message) =>
      `REVIEW FINDINGS\n\n1. review for ${runId}\n\nARCHITECT MESSAGE\n\n${message}`,
    continueCommandDependencies: {
      continueRun: async (_id, message, _limit, produceMessage, options) => {
        received = produceMessage ? produceMessage() : message
        expect(options?.continuedWithFindings).toBeTrue()
        return { childId: '99', job: 'implement', reported: false }
      },
      reportContinuedRun: async () => {},
    },
  })

  const argv = [
    'node',
    'orch',
    'continue',
    String(number),
    '--findings',
    'Keep this architect message verbatim.',
  ]
  setRawArgv(argv.slice(2))
  await program.parseAsync(argv)

  expect(received).toBe(
    `REVIEW FINDINGS\n\n1. review for ${recordId}\n\nARCHITECT MESSAGE\n\nKeep this architect message verbatim.`,
  )
})

test('continue without --findings hands the architect message through unchanged', async () => {
  const recordId = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  bindRunToCursor(recordId)
  const number = (
    db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as {
      number: number
    }
  ).number
  const program = new Command().exitOverride()
  let received: string | undefined
  register(program, {
    continuationFindingsForRun: () => {
      throw new Error('findings renderer must not be called')
    },
    continueCommandDependencies: {
      continueRun: async (_id, message, _limit, produceMessage, options) => {
        received = produceMessage ? produceMessage() : message
        expect(options?.continuedWithFindings).toBeFalse()
        return { childId: '99', job: 'implement', reported: false }
      },
      reportContinuedRun: async () => {},
    },
  })

  const argv = ['node', 'orch', 'continue', String(number), 'Continue exactly as before.']
  setRawArgv(argv.slice(2))
  await program.parseAsync(argv)

  expect(received).toBe('Continue exactly as before.')
})

test('continue repairs an orphaned asking turn before invoking the continuation service', async () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const asking = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    parent: root,
    turn: 2,
  })
  addRun({ agent: 'codex', job: 'implement', status: 'ok', parent: root, turn: 3 })
  bindRunToCursor(root)
  const number = (
    db().query('SELECT number FROM run WHERE record_id=?').get(root) as { number: number }
  ).number
  const program = new Command().exitOverride()
  register(program, {
    continueCommandDependencies: {
      continueRun: async () => {
        expect(db().query('SELECT status FROM run WHERE record_id=?').get(asking)).toEqual({
          status: 'ok',
        })
        return { childId: 'child', job: 'implement', reported: false }
      },
      reportContinuedRun: async () => {},
    },
  })

  await program.parseAsync(['node', 'orch', 'continue', String(number), 'continue latest'])

  expect(
    db().query('SELECT action FROM run_mutation_audit WHERE run_record_id=?').get(asking),
  ).toEqual({
    action: 'reap',
  })
})

test('continue admits the later turn and records an attributed override on its child', async () => {
  const recordId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const number = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(recordId)!.number
  const admissions: unknown[] = []
  const warnings: unknown[] = []
  const program = new Command().exitOverride()
  register(program, {
    continueCommandDependencies: {
      admitKeyedTurn: async (input) => {
        admissions.push(input)
        return { warning: 'operator override warning', binding: undefined }
      },
      continueRun: async () => ({ childId: 'child-record-id', job: 'implement', reported: false }),
      reportContinuedRun: async () => {},
      recordKeyedTurnOverride: (runId, warning) => {
        if (warning) warnings.push({ runId, warning })
      },
    },
  })

  const argv = [
    'node',
    'orch',
    'continue',
    String(number),
    '--override-unbound',
    'operator approved',
    '--from-operator',
    'Continue.',
  ]
  setRawArgv(argv.slice(2))
  await program.parseAsync(argv)

  expect(admissions).toEqual([
    {
      runId: recordId,
      turn: 'continue',
      overrideReason: 'operator approved',
      fromOperator: true,
    },
  ])
  expect(warnings).toEqual([{ runId: 'child-record-id', warning: 'operator override warning' }])
})

test('continue refuses an unknown option before --file instead of sending the option text', async () => {
  const recordId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const number = (
    db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as { number: number }
  ).number
  const program = new Command().exitOverride()
  let launched = false
  register(program, {
    continueCommandDependencies: {
      continueRun: async () => {
        launched = true
        return { childId: '99', job: 'implement', reported: false }
      },
      reportContinuedRun: async () => {},
    },
  })
  const argv = [
    'node',
    'orch',
    'continue',
    String(number),
    '--agent',
    'codex',
    '--file',
    'fixes.md',
  ]
  setRawArgv(argv.slice(2))

  await expect(program.parseAsync(argv)).rejects.toThrow(
    /unknown option --agent[\s\S]*working form/,
  )
  expect(launched).toBe(false)
})

test('continue parses --file before the id and reads only the file content', async () => {
  const recordId = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  bindRunToCursor(recordId)
  const number = (
    db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as {
      number: number
    }
  ).number
  const path = trackResidue(join(dir, 'continue-before-id.txt'))
  writeFileSync(path, 'Review fix from file.\n')
  const program = new Command().exitOverride()
  let received: string | undefined
  register(program, {
    continueCommandDependencies: {
      continueRun: async (_id, message) => {
        received = message
        return { childId: '99', job: 'implement', reported: false }
      },
      reportContinuedRun: async () => {},
    },
  })

  const argv = ['node', 'orch', 'continue', '--file', path, String(number)]
  setRawArgv(argv.slice(2))
  await program.parseAsync(argv)
  expect(received).toBe('Review fix from file.\n')
})

test('continue refuses an empty file before launch', async () => {
  const recordId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const number = (
    db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as { number: number }
  ).number
  const path = trackResidue(join(dir, 'continue-empty.txt'))
  writeFileSync(path, '')
  const program = new Command().exitOverride()
  let launched = false
  register(program, {
    continueCommandDependencies: {
      continueRun: async () => {
        launched = true
        return { childId: '99', job: 'implement', reported: false }
      },
      reportContinuedRun: async () => {},
    },
  })
  const argv = ['node', 'orch', 'continue', '--file', path, String(number)]
  setRawArgv(argv.slice(2))

  await expect(program.parseAsync(argv)).rejects.toThrow('empty message')
  expect(launched).toBe(false)
})

test('continue resolves a run UUID to the same local row as its number', async () => {
  const recordId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  bindRunToCursor(recordId)
  const number = (
    db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as {
      number: number
    }
  ).number
  const received: string[] = []
  for (const identifier of [String(number), recordId.toUpperCase()]) {
    const program = new Command().exitOverride()
    register(program, {
      continueCommandDependencies: {
        continueRun: async (runId) => {
          received.push(runId)
          return { childId: '99', job: 'implement', reported: false }
        },
        reportContinuedRun: async () => {},
      },
    })
    const argv = ['node', 'orch', 'continue', identifier, 'Continue.']
    setRawArgv(argv.slice(2))
    await program.parseAsync(argv)
  }
  expect(received).toEqual([recordId, recordId])
})
