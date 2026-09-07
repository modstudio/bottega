import { expect, mock, test } from 'bun:test'
import type { RegisteredProject } from '../src/projects.ts'

const tracker = (id: number, name: string): RegisteredProject => ({
  id, name, path: `/fixtures/${name}`, stack: null, canon: true,
  settings: {
    keyPrefixes: [name.toUpperCase()],
    tracker: { protocol: 'array-mcp', envPrefix: name.toUpperCase(), openStatuses: ['open'] },
  },
})

const register = [tracker(1, 'alpha')]
mock.module('../src/projects.ts', () => ({
  projects: () => register,
  projectRoot: () => '/fixtures',
}))
mock.module('../src/ingest/git.ts', () => ({
  ingestGit: () => ({ days: 0, tasks: 0 }),
}))
mock.module('../src/orch.ts', () => ({
  readRuns: async () => [],
  projectAdd: async (body: { name?: string }) => {
    const added = tracker(register.length + 1, body.name ?? 'added')
    register.push(added)
    return added
  },
}))

let initialized = 0
mock.module('../src/mcp.ts', () => ({
  credentials: (name: string) => ({ url: `https://${name}.invalid`, token: 'fixture' }),
  Mcp: class {
    async initialize() { initialized++ }
    async callTool() { return [] }
  },
}))

const { collectSlow } = await import('../src/collect.ts')
const { projectAdd } = await import('../src/orch.ts')

test('live tracker registry fixture', async () => {
  await collectSlow(true)
  expect(initialized).toBe(1)

  await projectAdd({ name: 'beta', path: '/fixtures/beta' })
  await collectSlow(true)

  // Alpha is backed off after its quiet result; only the newly registered
  // beta tracker connects on the second pass.
  expect(initialized).toBe(2)
})
