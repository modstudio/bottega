import { expect, test } from 'bun:test'
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

test('continue parses --findings before the message and hands the rendered text to continuation', async () => {
  const recordId = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
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
      continueRun: async (_id, message, _limit, produceMessage) => {
        received = produceMessage ? produceMessage() : message
        return { childId: '99', job: 'implement' }
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
      continueRun: async (_id, message, _limit, produceMessage) => {
        received = produceMessage ? produceMessage() : message
        return { childId: '99', job: 'implement' }
      },
      reportContinuedRun: async () => {},
    },
  })

  const argv = ['node', 'orch', 'continue', String(number), 'Continue exactly as before.']
  setRawArgv(argv.slice(2))
  await program.parseAsync(argv)

  expect(received).toBe('Continue exactly as before.')
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
        return { childId: '99', job: 'implement' }
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
        return { childId: '99', job: 'implement' }
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
        return { childId: '99', job: 'implement' }
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
          return { childId: '99', job: 'implement' }
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
