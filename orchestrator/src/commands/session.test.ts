import { expect, test } from 'bun:test'
import { Command, CommanderError } from 'commander'
import { addRun } from '../../test/fixtures/store.ts'
import { db, SESSION_LIVE_MS } from '../database/db.ts'
import { register } from './session.ts'
import { drainStdout } from './support.ts'

async function runRegisteredCommand(argv: readonly string[]) {
  const stdout: string[] = []
  const originalWrite = process.stdout.write
  const originalExitCode = process.exitCode
  process.exitCode = 0
  process.stdout.write = ((value: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    stdout.push(String(value))
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    if (typeof done === 'function') done()
    return true
  }) as typeof process.stdout.write
  const program = new Command().enablePositionalOptions().exitOverride().allowExcessArguments(false)
  register(program)
  let code = 0
  try {
    await program.parseAsync(['node', 'orch', ...argv])
  } catch (error) {
    code = error instanceof CommanderError ? 2 : 1
    stdout.push(error instanceof Error ? error.message : String(error))
  } finally {
    await drainStdout()
    process.stdout.write = originalWrite
  }
  code = Number(process.exitCode || code)
  process.exitCode = originalExitCode
  return { code, output: stdout.join('') }
}

test('session adopt maps --cut-off to cut-off consent for a recently seen gone process', async () => {
  const prior = process.env.CLAUDE_CODE_SESSION_ID
  const owner = 'cut-off-owner'
  const actor = 'successor'
  const reason = 'owner terminal disappeared'
  const gonePid = 2_147_483_647
  const lastSeenAt = Date.now() - 1_000
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: owner })
  db()
    .query('INSERT INTO session_seen(session_id,last_seen,ancestor_chain) VALUES (?,?,?)')
    .run(
      owner,
      new Date(lastSeenAt).toISOString(),
      JSON.stringify([{ pid: gonePid, startTime: 'gone-start' }]),
    )
  process.env.CLAUDE_CODE_SESSION_ID = actor

  try {
    const refused = await runRegisteredCommand(['session', 'adopt', owner, '--reason', reason])
    expect(refused).toMatchObject({ code: 1 })
    expect(refused.output).toContain(
      `wait until ${new Date(lastSeenAt + SESSION_LIVE_MS + 1).toISOString()}`,
    )

    const adopted = await runRegisteredCommand([
      'session',
      'adopt',
      owner,
      '--reason',
      reason,
      '--cut-off',
    ])
    expect(adopted).toMatchObject({ code: 0 })
    expect(db().query('SELECT session_id FROM run WHERE record_id=?').get(root)).toEqual({
      session_id: actor,
    })
    expect(db().query("SELECT reason FROM run_mutation_audit WHERE action='adopt'").get()).toEqual({
      reason: `consent cut-off: ${reason}`,
    })
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = prior
  }
})

test('session losses requires an explicit transcript selection', async () => {
  const result = await runRegisteredCommand(['session', 'losses', '--json'])
  expect(result.code).toBe(1)
  expect(result.output).toContain('--session <id>')
  expect(result.output).toContain('--all')
})
