import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'hub-task-cli-'))
const database = join(dir, 'hub.db')
const cli = new URL('./cli.ts', import.meta.url).pathname
const decoder = new TextDecoder()

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function hub(...args: string[]) {
  const result = Bun.spawnSync(['bun', cli, ...args], {
    env: { ...process.env, HUB_DB: database },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout).trim(),
    stderr: decoder.decode(result.stderr).trim(),
  }
}

function show(key: string) {
  const result = hub('task', 'show', key, '--json')
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout).task as { body: string | null }
}

describe('task CLI bodies', () => {
  test('creates a task complete with an argv body in one command', () => {
    const created = hub('task', 'new', '--project', 'workshop', '--title', 'Complete task',
      '--body', 'The complete body')

    expect(created.exitCode).toBe(0)
    expect(show(created.stdout).body).toBe('The complete body')
  })

  test('creates a task complete from a body file in one command', () => {
    const path = join(dir, 'body.txt')
    writeFileSync(path, 'A body with\nmultiple lines.\n')

    const created = hub('task', 'new', '--project', 'workshop', '--title', 'File body',
      '--body-file', path)

    expect(created.exitCode).toBe(0)
    expect(show(created.stdout).body).toBe('A body with\nmultiple lines.\n')
  })

  test('refuses to replace a non-empty body and --force permits it', () => {
    const created = hub('task', 'new', '--project', 'workshop', '--title', 'Guarded',
      '--body', 'Hand-written work that must survive')
    const refused = hub('task', 'set', created.stdout, '--body', 'Replacement')

    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('Hand-written work that must survive')
    expect(refused.stderr).toContain('--force')
    expect(show(created.stdout).body).toBe('Hand-written work that must survive')

    const forced = hub('task', 'set', created.stdout, '--body', 'Replacement', '--force')
    expect(forced.exitCode).toBe(0)
    expect(show(created.stdout).body).toBe('Replacement')
  })

  test('allows replacing an empty body but refuses a whitespace-only body', () => {
    const empty = hub('task', 'new', '--project', 'workshop', '--title', 'Empty', '--body', '')
    expect(hub('task', 'set', empty.stdout, '--body', 'Now filled').exitCode).toBe(0)
    expect(show(empty.stdout).body).toBe('Now filled')

    const whitespace = hub('task', 'new', '--project', 'workshop', '--title', 'Whitespace',
      '--body', '   \n')
    const refused = hub('task', 'set', whitespace.stdout, '--body', 'Replacement')
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('--force')
    expect(show(whitespace.stdout).body).toBe('   \n')
  })
})
