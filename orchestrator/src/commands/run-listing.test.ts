import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { register } from './run-listing.ts'
import { drainStdout } from './support.ts'

async function runList(identifiers: string[]): Promise<Record<string, unknown>[]> {
  const output = await runListOutput([
    ...identifiers.flatMap((identifier) => ['--id', identifier]),
    '--json',
  ])
  return output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((parsed) => (parsed.data as Record<string, unknown> | undefined) ?? parsed)
}

async function runListOutput(args: string[]): Promise<string> {
  const stdout: string[] = []
  const originalWrite = process.stdout.write
  process.stdout.write = ((value: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    stdout.push(String(value))
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    if (typeof done === 'function') done()
    return true
  }) as typeof process.stdout.write
  const program = new Command().exitOverride()
  register(program)
  try {
    await program.parseAsync(['node', 'orch', 'runs', ...args])
    await drainStdout()
  } finally {
    process.stdout.write = originalWrite
  }
  return stdout.join('')
}

test('runs adapter resolves known numbers and preserves unknown number and UUID identities', async () => {
  const recordId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const number = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(recordId)!.number
  const unknownRecordId = newRecordId()
  const rows = await runList([String(number), String(number + 10_000), unknownRecordId])
  expect(rows[0]).toMatchObject({ record_id: recordId })
  expect(rows[1]).toEqual({
    number: number + 10_000,
    status: 'unknown',
    unknown: true,
  })
  expect(rows[2]).toEqual({
    record_id: unknownRecordId,
    status: 'unknown',
    unknown: true,
  })
})

test.each(['vendor-probe', 'not-a-job'])(
  'registered human runs renders recorded undeclared job %s',
  async (job) => {
    const recordId = addRun({ agent: 'codex', job, status: 'ok' })
    const number = db()
      .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
      .get(recordId)!.number

    expect(await runListOutput(['--id', recordId])).toMatch(
      new RegExp(`\\b${number}\\s+codex\\s+${job}\\b`),
    )
  },
)
