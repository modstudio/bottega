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

function document(id: string) {
  const result = hub('task', 'doc', 'show', id, '--json')
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout) as {
    id: number; task_key: string; role: string | null; title: string
    body: string; version: string
  }
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

describe('task documents', () => {
  test('creates several documents and keeps task show compact', () => {
    const task = hub('task', 'new', '--project', 'workshop', '--title', 'Documented task',
      '--body', 'A short description.')
    const rulings = hub('task', 'doc', 'new', task.stdout, '--title', 'Rulings',
      '--body', 'Long ruling body that is read separately.')
    const handoff = hub('task', 'doc', 'new', task.stdout, '--title', 'Resume here',
      '--role', 'handoff', '--body', 'Full workflow context.')

    expect(rulings.exitCode).toBe(0)
    expect(handoff.exitCode).toBe(0)
    expect(document(rulings.stdout).body).toBe('Long ruling body that is read separately.')
    expect(document(handoff.stdout).role).toBe('handoff')

    const shown = hub('task', 'show', task.stdout)
    expect(shown.stdout).toContain(`documents:`)
    expect(shown.stdout).toContain(`${rulings.stdout}  Rulings — hub task doc show ${rulings.stdout}`)
    expect(shown.stdout).toContain(`${handoff.stdout} [handoff]  Resume here`)
    expect(shown.stdout).not.toContain('Long ruling body that is read separately.')
    expect(shown.stdout).not.toContain('Full workflow context.')
  })

  test('only known roles are accepted and a task has at most one document in a role', () => {
    const task = hub('task', 'new', '--project', 'workshop', '--title', 'Role owner')
    expect(hub('task', 'doc', 'new', task.stdout, '--title', 'Question',
      '--role', 'request').stderr).toContain("invalid document role 'request'")
    expect(hub('task', 'doc', 'new', task.stdout, '--title', 'First',
      '--role', 'handoff').exitCode).toBe(0)

    const duplicate = hub('task', 'doc', 'new', task.stdout, '--title', 'Second',
      '--role', 'handoff')
    expect(duplicate.exitCode).toBe(1)
    expect(duplicate.stderr).toContain('UNIQUE constraint failed')
  })

  test('a body update requires the version read and atomically refuses a stale writer', () => {
    const task = hub('task', 'new', '--project', 'workshop', '--title', 'Concurrent edits')
    const created = hub('task', 'doc', 'new', task.stdout, '--title', 'Working notes',
      '--body', 'version one')
    const firstRead = document(created.stdout)

    const withoutVersion = hub('task', 'doc', 'set', created.stdout, '--body', 'unguarded')
    expect(withoutVersion.exitCode).toBe(1)
    expect(withoutVersion.stderr).toContain('requires --version')

    const changed = hub('task', 'doc', 'set', created.stdout, '--body', 'version two',
      '--version', firstRead.version)
    expect(changed.exitCode).toBe(0)
    const secondRead = document(created.stdout)
    expect(secondRead.body).toBe('version two')
    expect(secondRead.version).not.toBe(firstRead.version)

    const stale = hub('task', 'doc', 'set', created.stdout, '--body', 'lost update',
      '--version', firstRead.version)
    expect(stale.exitCode).toBe(1)
    expect(stale.stderr).toContain('changed since version')
    expect(document(created.stdout).body).toBe('version two')
  })

  test('lists metadata, edits metadata without resending a body, and removes one document', () => {
    const task = hub('task', 'new', '--project', 'workshop', '--title', 'Document lifecycle')
    const created = hub('task', 'doc', 'new', task.stdout, '--title', 'Notes', '--body', 'kept')
    const renamed = hub('task', 'doc', 'set', created.stdout, '--title', 'Findings',
      '--role', 'handoff')
    expect(renamed.exitCode).toBe(0)
    expect(document(created.stdout)).toMatchObject({ title: 'Findings', body: 'kept', role: 'handoff' })

    const listed = hub('task', 'doc', 'list', task.stdout, '--json')
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ id: Number(created.stdout), title: 'Findings', role: 'handoff' }),
    ])
    expect(listed.stdout).not.toContain('kept')

    expect(hub('task', 'doc', 'rm', created.stdout).exitCode).toBe(0)
    expect(hub('task', 'doc', 'list', task.stdout).stdout).toBe('no documents')
  })
})
