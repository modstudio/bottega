import { describe, expect, mock, test } from 'bun:test'
import { createProjectRouter } from './routers/project.ts'
import type { RegisteredProject } from '../projects.ts'

/**
 * bun:test `mock.module` intercepts `hub/src/orch.ts` before the doc router
 * loads it. router.test.ts previously imported appRouter statically and did
 * not mock; project.list still does not touch orch, so that test is unchanged.
 */
const docList = mock(async (_filters?: unknown) => [] as unknown[])
const docGet = mock(async (_scope: string, _subject: string | null, _slug: string) =>
  ({}) as unknown)
const docSet = mock(async (_input: unknown) => ({}) as unknown)
const docRemove = mock(async (_scope: string, _subject: string | null, _slug: string) =>
  ({ removed: false }))
const docSubjects = mock(async () => ({ project: [] as string[], agent: [] as string[], job: [] as string[] }))

mock.module('../orch.ts', () => ({
  docList, docGet, docSet, docRemove, docSubjects,
}))

const { appRouter } = await import('./router.ts')
const caller = appRouter.createCaller({})

const row = {
  id: 1,
  scope: 'global' as const,
  subject: null,
  slug: 'hello',
  title: 'Hello',
  body: 'Hi',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

describe('project.list', () => {
  test('returns the project register rows', async () => {
    const rows = await caller.project.list()

    expect(rows).toHaveLength(6)
    expect(rows[0]).toEqual({
      id: 1,
      name: 'alpha',
      path: '/fixtures/repos/alpha',
      stack: null,
      canon: true,
      settings: {
        keyPrefixes: ['ALP'],
        color: '#112233',
        colorDark: '#aabbcc',
        tracker: {
          protocol: 'workspace-mcp',
          envPrefix: 'FIXTURE_NO_CREDENTIALS',
          openStatuses: ['started'],
          states: { started: 'active', completed: 'done' },
        },
      },
      trackerStatus: {
        state: 'configured',
        label: 'workspace-mcp',
        error: null,
      },
    })
  })
})

describe('doc router', () => {
  test('list passes filters through to docList', async () => {
    docList.mockResolvedValueOnce([row])
    const rows = await caller.doc.list({ scope: 'global' })
    expect(docList).toHaveBeenCalledWith({ scope: 'global' })
    expect(rows).toEqual([row])
  })

  test('get passes scope, subject and slug to docGet', async () => {
    docGet.mockResolvedValueOnce(row)
    const got = await caller.doc.get({ scope: 'global', subject: null, slug: 'hello' })
    expect(docGet).toHaveBeenCalledWith('global', null, 'hello')
    expect(got).toEqual(row)
  })

  test('set passes the input to docSet', async () => {
    const input = { scope: 'global' as const, subject: null, slug: 'hello', title: 'Hello', body: 'Hi' }
    docSet.mockResolvedValueOnce(row)
    const got = await caller.doc.set(input)
    expect(docSet).toHaveBeenCalledWith(input)
    expect(got).toEqual(row)
  })

  test('remove passes scope, subject and slug to docRemove', async () => {
    docRemove.mockResolvedValueOnce({ removed: true })
    const got = await caller.doc.remove({ scope: 'global', subject: null, slug: 'hello' })
    expect(docRemove).toHaveBeenCalledWith('global', null, 'hello')
    expect(got).toEqual({ removed: true })
  })

  test('subjects returns what docSubjects returns', async () => {
    const subjects = { project: ['alpha'], agent: ['codex'], job: ['implement'] }
    docSubjects.mockResolvedValueOnce(subjects)
    expect(await caller.doc.subjects()).toEqual(subjects)
    expect(docSubjects).toHaveBeenCalled()
  })

  test('orch errors surface as BAD_REQUEST with orch\'s message', async () => {
    docGet.mockRejectedValueOnce(new Error('orch doc exited 1: invalid slug; use 1-64 lowercase'))
    let thrown: unknown
    try {
      await caller.doc.get({ scope: 'global', subject: null, slug: 'Bad' })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toMatchObject({ code: 'BAD_REQUEST', message: 'invalid slug; use 1-64 lowercase' })
  })
})

describe('project writes', () => {
  const row: RegisteredProject = {
    id: 10, name: 'new-project', path: '/tmp/new-project', stack: 'bun', canon: true,
    settings: {},
  }

  test('add forwards its validated input to the injected orch function', async () => {
    let received: unknown
    const router = createProjectRouter({
      add: async (input) => { received = input; return row },
      set: async () => row,
      remove: async () => {},
    })
    const result = await router.createCaller({}).add({
      path: row.path, name: row.name, stack: row.stack!, canon: false,
    })
    expect(received).toEqual({ path: row.path, name: row.name, stack: 'bun', canon: false })
    expect(result).toEqual(row)
  })

  test('set separates the name and preserves null settings values', async () => {
    let received: unknown
    const router = createProjectRouter({
      add: async () => row,
      set: async (name, body) => { received = [name, body]; return row },
      remove: async () => {},
    })
    await router.createCaller({}).set({
      name: row.name, settings: { tracker: null }, canon: true,
    })
    expect(received).toEqual([row.name, { settings: { tracker: null }, canon: true }])
  })

  test('remove forwards the name and surfaces orch errors as BAD_REQUEST', async () => {
    let received: string | undefined
    const router = createProjectRouter({
      add: async () => row,
      set: async () => row,
      remove: async (name) => { received = name; throw new Error('no project "missing"') },
    })
    const failure = router.createCaller({}).remove({ name: 'missing' })
    expect(received).toBeUndefined()
    await expect(failure).rejects.toMatchObject({
      code: 'BAD_REQUEST', message: 'no project "missing"',
    })
    expect(received).toBe('missing')
  })
})
