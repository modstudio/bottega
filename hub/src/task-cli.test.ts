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
  return hubAt(database, ...args)
}

function hubAt(path: string, ...args: string[]) {
  const result = Bun.spawnSync(['bun', cli, ...args], {
    env: { ...process.env, HUB_DB: path },
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
  return JSON.parse(result.stdout).task as { title: string | null; body: string | null }
}

describe('task CLI bodies', () => {
  test('queries refuse an absent database instead of reporting an empty finding', () => {
    const absent = join(dir, 'absent.db')
    for (const args of [['task', 'show', 'DEV-154'], ['task', 'list'], ['tasks']]) {
      const result = hubAt(absent, ...args)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('hub database is absent')
      expect(result.stderr).toContain('cannot answer from missing data')
    }
  })

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

describe('task CLI dash-leading values', () => {
  test('stores a title that begins with two dashes verbatim', () => {
    const created = hub('task', 'new', '--project', 'workshop',
      '--title', '--base is advertised unconditionally ...', '--body', '...')

    expect(created.exitCode).toBe(0)
    expect(created.stderr).toBe('')
    const row = show(created.stdout)
    expect(row.title).toBe('--base is advertised unconditionally ...')
    expect(row.body).toBe('...')
  })

  test('stores a body that begins with a dash verbatim', () => {
    const created = hub('task', 'new', '--project', 'workshop', '--title', 'Flag body',
      '--body', '--force is the override, not the default')

    expect(created.exitCode).toBe(0)
    expect(show(created.stdout).body).toBe('--force is the override, not the default')
  })

  test('reads a body file whose path begins with a dash', () => {
    const path = join(dir, '--dash-body.txt')
    writeFileSync(path, 'Body from a dash-leading path.\n')

    const created = hub('task', 'new', '--project', 'workshop', '--title', 'Dash path',
      '--body-file', path)

    expect(created.exitCode).toBe(0)
    expect(show(created.stdout).body).toBe('Body from a dash-leading path.\n')
  })

  test('task set keeps a dash-leading title', () => {
    const created = hub('task', 'new', '--project', 'workshop', '--title', 'Before')
    const updated = hub('task', 'set', created.stdout, '--title', '--after the flag')

    expect(updated.exitCode).toBe(0)
    expect(show(created.stdout).title).toBe('--after the flag')
  })

  test('an omitted title still reports as missing', () => {
    const result = hub('task', 'new', '--project', 'workshop', '--body', '...')

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('--title is required')
  })

  test('an omitted project still reports as missing', () => {
    const result = hub('task', 'new', '--title', '--base is advertised unconditionally ...')

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('--project is required')
  })
})
