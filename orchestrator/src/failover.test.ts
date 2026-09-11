import { expect, test } from 'bun:test'
import { detachedRunOptions } from './failover.ts'

test('the detached spec mapping forwards every field to run', () => {
  const resume = {
    parent: 11, agent: 'codex', session: 'session', turn: 2, sessionId: 'owner',
    worktree: { path: '/tmp/tree', branch: 'DEV-63', base: 'main', repoRoot: '/tmp/repo' },
  }
  expect(detachedRunOptions('implement', 'prompt', 42, {
    agent: 'codex', schema: '/tmp/schema.json', mcp: true, model: 'model', probe: true,
    transport: 'cli', label: 'security lens', lens: 'security', seed: 'small',
    key: 'DEV-63', repo: 'project', base: 'main', avoid: ['grok'],
    distinctModels: ['other-model'], retryOf: 7, cwd: '/tmp/repo', noFailover: true,
    noWaitCapacity: true, carry: true, review: 'feature/DEV-63', ownerSession: 'owner',
    resume, deliverables: ['timing'], timeoutMinutes: 40, keepTree: true,
  })).toMatchObject({
    job: 'implement', prompt: 'prompt', reserveId: 42, agent: 'codex',
    schemaPath: '/tmp/schema.json', mcp: true, model: 'model', probe: true,
    transport: 'cli', label: 'security lens', lens: 'security', seed: 'small',
    key: 'DEV-63', repo: 'project', base: 'main', avoid: ['grok'],
    distinctModels: ['other-model'], retryOf: 7, cwd: '/tmp/repo', noFailover: true,
    noWaitCapacity: true, carry: true, review: 'feature/DEV-63', ownerSession: 'owner',
    resume, deliverables: ['timing'], timeoutMinutes: 40, keepTree: true,
  })
})

