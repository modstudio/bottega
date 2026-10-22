import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { register } from './logic.ts'
import { setRawArgv } from './support.ts'

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
    '--file appeared after continuation message parsing began at "--agent"; the file was not read',
  )
  expect(launched).toBe(false)
})

test('continue refuses --findings after the message and names the working order', async () => {
  const recordId = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  const number = (
    db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as {
      number: number
    }
  ).number
  const program = new Command().exitOverride()
  register(program)

  const argv = ['node', 'orch', 'continue', String(number), 'Apply this.', '--findings']
  setRawArgv(argv.slice(2))
  await expect(program.parseAsync(argv)).rejects.toThrow(
    /--findings must appear before the message[\s\S]*working form/,
  )
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
