import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { register } from './logic.ts'
import { setRawArgv } from './support.ts'

test('lens set accepts the requires-execution option at the CLI edge', () => {
  const program = new Command()
  register(program)
  const lens = program.commands.find((command) => command.name() === 'lens')
  expect(lens?.options.some((option) => option.long === '--requires-execution')).toBe(true)
})

test('continue parses --findings before the message and hands the rendered text to continuation', async () => {
  const program = new Command().exitOverride()
  let received: string | undefined
  register(program, {
    continuationFindingsForRun: (_database, runId, message) =>
      `REVIEW FINDINGS\n\n1. review for ${runId}\n\nARCHITECT MESSAGE\n\n${message}`,
    continueCommandDependencies: {
      continueRun: async (_id, message, _limit, produceMessage) => {
        received = produceMessage ? produceMessage() : message
        return { childId: 99, job: 'implement' }
      },
      reportContinuedRun: async () => {},
    },
  })

  const argv = [
    'node',
    'orch',
    'continue',
    '42',
    '--findings',
    'Keep this architect message verbatim.',
  ]
  setRawArgv(argv.slice(2))
  await program.parseAsync(argv)

  expect(received).toBe(
    'REVIEW FINDINGS\n\n1. review for 42\n\nARCHITECT MESSAGE\n\nKeep this architect message verbatim.',
  )
})

test('continue without --findings hands the architect message through unchanged', async () => {
  const program = new Command().exitOverride()
  let received: string | undefined
  register(program, {
    continuationFindingsForRun: () => {
      throw new Error('findings renderer must not be called')
    },
    continueCommandDependencies: {
      continueRun: async (_id, message, _limit, produceMessage) => {
        received = produceMessage ? produceMessage() : message
        return { childId: 99, job: 'implement' }
      },
      reportContinuedRun: async () => {},
    },
  })

  const argv = ['node', 'orch', 'continue', '42', 'Continue exactly as before.']
  setRawArgv(argv.slice(2))
  await program.parseAsync(argv)

  expect(received).toBe('Continue exactly as before.')
})

test('continue refuses --findings after the message and names the working order', async () => {
  const program = new Command().exitOverride()
  register(program)

  const argv = ['node', 'orch', 'continue', '42', 'Apply this.', '--findings']
  setRawArgv(argv.slice(2))
  await expect(program.parseAsync(argv)).rejects.toThrow(
    /--findings must appear before the message[\s\S]*working form/,
  )
})

test('continue resolves a run UUID to the same local row as its number', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const recordId = (
    db().query('SELECT record_id FROM run WHERE id=?').get(id) as { record_id: string }
  ).record_id
  const received: number[] = []
  for (const identifier of [String(id), recordId.toUpperCase()]) {
    const program = new Command().exitOverride()
    register(program, {
      continueCommandDependencies: {
        continueRun: async (runId) => {
          received.push(runId)
          return { childId: 99, job: 'implement' }
        },
        reportContinuedRun: async () => {},
      },
    })
    const argv = ['node', 'orch', 'continue', identifier, 'Continue.']
    setRawArgv(argv.slice(2))
    await program.parseAsync(argv)
  }
  expect(received).toEqual([id, id])
})
