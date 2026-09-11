import { describe, expect, test } from 'bun:test'
import { decideFailover, detachedRunOptions } from './failover.ts'

const base = {
  status: 'failed', failureKind: 'quota', failoverKinds: ['quota'],
  noFailover: false, writesJob: false, changes: { files: [] },
  worktree: '(none — read-only job)', attemptCount: 1, maxAttempts: 3,
  agentsTried: ['grok'], originalPromptAvailable: true,
}

describe('decideFailover', () => {
  test('non-failover outcome takes no action', () => {
    expect(decideFailover({ ...base, status: 'ok' })).toEqual({ kind: 'none' })
  })

  test('--no-failover refuses', () => {
    expect(decideFailover({ ...base, noFailover: true })).toEqual({
      kind: 'refusal',
      reason: 'disabled by --no-failover; worktree (none — read-only job)',
    })
  })

  test('writing changes refuse', () => {
    expect(decideFailover({
      ...base, writesJob: true, changes: { files: ['src/a.ts'] }, worktree: '/tmp/tree',
    })).toEqual({
      kind: 'refusal',
      reason: 'writing run has 1 changed file(s); preserving worktree /tmp/tree so two agents never share one diff',
    })
  })

  test('spent attempt budget refuses', () => {
    expect(decideFailover({ ...base, attemptCount: 3 })).toEqual({
      kind: 'refusal',
      reason: 'the 3-attempt budget was spent; tried grok; worktree (none — read-only job)',
    })
  })

  test('missing original prompt refuses', () => {
    expect(decideFailover({ ...base, originalPromptAvailable: false })).toEqual({
      kind: 'refusal',
      reason: 'the original prompt is no longer on disk; tried grok; worktree (none — read-only job)',
    })
  })

  test('eligible facts request selection', () => {
    expect(decideFailover(base)).toEqual({ kind: 'select' })
  })

  test('selection failure refuses', () => {
    expect(decideFailover({ ...base, selectionError: 'all excluded' })).toEqual({
      kind: 'refusal',
      reason: 'no eligible agent remains after trying grok: all excluded; worktree (none — read-only job)',
    })
  })

  test('selected agent becomes successor', () => {
    expect(decideFailover({ ...base, successor: { agent: 'codex' } })).toEqual({
      kind: 'successor', agent: 'codex',
    })
  })
})

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

