import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { docArgv, docGet, docRemove, docSet, projectArgv } from './orch.ts'

describe('docArgv', () => {
  test('list with no filters', () => {
    expect(docArgv('list')).toEqual(['doc', 'list', '--json'])
  })

  test('list with scope', () => {
    expect(docArgv('list', { scope: 'global' })).toEqual(
      ['doc', 'list', '--scope', 'global', '--json'],
    )
  })

  test('list with scope and subject', () => {
    expect(docArgv('list', { scope: 'project', subject: 'alpha' })).toEqual(
      ['doc', 'list', '--scope', 'project', '--subject', 'alpha', '--json'],
    )
  })

  test('get without subject', () => {
    expect(docArgv('get', { scope: 'global', subject: null, slug: 'hello' })).toEqual(
      ['doc', 'show', 'hello', '--scope', 'global', '--json'],
    )
  })

  test('get with subject', () => {
    expect(docArgv('get', { scope: 'project', subject: 'alpha', slug: 'hello' })).toEqual(
      ['doc', 'show', 'hello', '--scope', 'project', '--subject', 'alpha', '--json'],
    )
  })

  test('set without subject does not put the body in argv', () => {
    const body = "quote' backtick` newline\n"
    const argv = docArgv('set', {
      scope: 'global', subject: null, slug: 'hello', title: 'Hi', body, reason: 'why',
    })
    expect(argv).toEqual(
      ['doc', 'set', 'hello', '--scope', 'global', '--title', 'Hi', '--reason', 'why', '--author', 'hub-dashboard', '--json'],
    )
    expect(argv).not.toContain(body)
  })

  test('set with subject', () => {
    expect(docArgv('set', {
      scope: 'agent', subject: 'codex', slug: 'notes', title: 'Notes', reason: 'why',
    })).toEqual(
      ['doc', 'set', 'notes', '--scope', 'agent', '--subject', 'codex', '--title', 'Notes', '--reason', 'why', '--author', 'hub-dashboard', '--json'],
    )
  })

  test('remove without subject', () => {
    expect(docArgv('remove', { scope: 'machine', subject: null, slug: 'host', reason: 'why' })).toEqual(
      ['doc', 'rm', 'host', '--scope', 'machine', '--reason', 'why', '--author', 'hub-dashboard', '--json'],
    )
  })

  test('remove with subject', () => {
    expect(docArgv('remove', { scope: 'job', subject: 'implement', slug: 'notes', reason: 'obsolete' })).toEqual(
      ['doc', 'rm', 'notes', '--scope', 'job', '--subject', 'implement', '--reason', 'obsolete', '--author', 'hub-dashboard', '--json'],
    )
  })

  test('subjects', () => {
    expect(docArgv('subjects')).toEqual(['doc', 'subjects', '--json'])
  })
})

describe('docSet stdin', () => {
  test('a body containing a single quote, a backtick and a newline round-trips unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-doc-'))
    const prev = process.env.ORCH_DB
    process.env.ORCH_DB = join(dir, 'orch.db')
    const body = "quote' backtick` newline\n"
    try {
      const row = await docSet({
        scope: 'global', subject: null, slug: 'round-trip', title: 'T', body, reason: 'test round trip',
      })
      expect(row.body).toBe(body)
      const got = await docGet('global', null, 'round-trip')
      expect(got.body).toBe(body)
      const removed = await docRemove('global', null, 'round-trip', 'test cleanup')
      expect(removed).toEqual({ removed: true })
    } finally {
      if (prev === undefined) delete process.env.ORCH_DB
      else process.env.ORCH_DB = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('projectArgv', () => {
  test('builds add argv with each canon state and no shell quoting', () => {
    expect(projectArgv('add', 'named project', {
      path: '/tmp/a path', stack: 'bun react', canon: true,
    })).toEqual([
      'project', 'add', '/tmp/a path', '--name', 'named project',
      '--stack', 'bun react', '--canon', '--json',
    ])
    expect(projectArgv('add', undefined, { path: '/tmp/project', canon: false })).toEqual([
      'project', 'add', '/tmp/project', '--no-canon', '--json',
    ])
    expect(projectArgv('add', undefined, { path: '/tmp/project' })).toEqual([
      'project', 'add', '/tmp/project', '--json',
    ])
  })

  test('builds set argv with optional settings and passes null through JSON', () => {
    expect(projectArgv('set', 'alpha', {
      path: '/tmp/a path', stack: 'ts', canon: false,
      settings: { tracker: null, nested: { value: null } },
    })).toEqual([
      'project', 'set', 'alpha', '--path', '/tmp/a path', '--stack', 'ts',
      '--no-canon', '--settings', '{"tracker":null,"nested":{"value":null}}', '--json',
    ])
    expect(projectArgv('set', 'alpha', { canon: true })).toEqual([
      'project', 'set', 'alpha', '--canon', '--json',
    ])
    expect(projectArgv('set', 'alpha', {})).toEqual([
      'project', 'set', 'alpha', '--json',
    ])
  })

  test('builds remove argv as separate array elements', () => {
    const argv = projectArgv('remove', 'a project')
    expect(argv).toEqual(['project', 'remove', 'a project'])
    expect(Array.isArray(argv)).toBe(true)
    expect(argv).not.toContain("'a project'")
  })
})
