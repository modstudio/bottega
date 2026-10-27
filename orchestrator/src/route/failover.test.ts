import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import {
  decideFailover,
  detachedRunOptions,
  failoverAttemptLimit,
  retryModelForAgent,
  writingFailoverRefusal,
} from './failover.ts'

const base = {
  status: 'failed',
  failureKind: 'quota',
  failoverKinds: ['quota'],
  noFailover: false,
  chainRoot: null,
  writesJob: false,
  changes: { files: [] },
  worktree: '(none — read-only job)',
  attemptCount: 1,
  maxAttempts: 3,
  agentsTried: ['grok'],
  originalPromptAvailable: true,
}

describe('decideFailover', () => {
  test('a premature final receives exactly one successor attempt', () => {
    expect(failoverAttemptLimit('premature-final')).toBe(2)
    expect(failoverAttemptLimit('quota')).toBe(3)
    expect(
      decideFailover({
        ...base,
        failureKind: 'premature-final',
        failoverKinds: ['premature-final'],
        attemptCount: 2,
        maxAttempts: failoverAttemptLimit('premature-final'),
      }),
    ).toMatchObject({ kind: 'refusal' })
  })
  test('non-failover outcome takes no action', () => {
    expect(decideFailover({ ...base, status: 'ok' })).toEqual({ kind: 'none' })
  })

  test('--no-failover refuses', () => {
    expect(decideFailover({ ...base, noFailover: true })).toEqual({
      kind: 'refusal',
      reason: 'disabled by --no-failover; worktree (none — read-only job)',
    })
  })

  test('a later turn stays on its chain while a root remains eligible', () => {
    const chainRoot = 'run-record-id-11'
    expect(decideFailover({ ...base, chainRoot })).toEqual({
      kind: 'refusal',
      reason: `a later turn does not fail over because a fresh root would drop its message and branch tip; worktree (none — read-only job); remedy: ${PLATFORM_SLUG} run continue run-record-id-11`,
    })
    expect(decideFailover({ ...base, chainRoot: null })).toEqual({ kind: 'select' })
  })

  test('writing changes refuse', () => {
    expect(
      decideFailover({
        ...base,
        writesJob: true,
        changes: { files: ['src/a.ts'] },
        worktree: '/tmp/tree',
      }),
    ).toEqual({
      kind: 'refusal',
      reason:
        'writing run has 1 changed file(s); preserving worktree /tmp/tree so two agents never share one diff',
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
      reason:
        'the original prompt is no longer on disk; tried grok; worktree (none — read-only job)',
    })
  })

  test('eligible facts request selection', () => {
    expect(decideFailover(base)).toEqual({ kind: 'select' })
  })

  test('selection failure refuses', () => {
    expect(decideFailover({ ...base, selectionError: 'all excluded' })).toEqual({
      kind: 'refusal',
      reason:
        'no eligible agent remains after trying grok: all excluded; worktree (none — read-only job)',
    })
  })

  test('selected agent becomes successor', () => {
    expect(decideFailover({ ...base, successor: { agent: 'codex' } })).toEqual({
      kind: 'successor',
      agent: 'codex',
    })
  })
})

test('the detached spec mapping forwards every field to run', () => {
  const resume = {
    kind: 'continue' as const,
    parent: 'run-record-id-11',
    agent: 'codex',
    session: 'session',
    turn: 2,
    sessionId: 'owner',
    worktree: { path: '/tmp/tree', branch: 'DEV-63', base: 'main', repoRoot: '/tmp/repo' },
  }
  expect(
    detachedRunOptions('implement', 'prompt', 'run-record-id-42', {
      agent: 'codex',
      routedAgent: { agent: 'codex', reason: 'thompson; best', promptBytes: 2048 },
      schema: '/tmp/schema.json',
      mcp: true,
      model: 'model',
      probe: true,
      transport: 'cli',
      label: 'security lens',
      lens: 'security',
      seed: 'small',
      key: 'DEV-63',
      repo: 'project',
      base: 'main',
      avoid: ['grok'],
      distinctModels: ['other-model'],
      retryOf: 'run-record-id-7',
      cwd: '/tmp/repo',
      noFailover: true,
      noWaitCapacity: true,
      carry: true,
      review: 'feature/DEV-63',
      ownerSession: 'owner',
      resume,
      deliverables: ['timing'],
      timeoutMinutes: 40,
      keepTree: { until: '2026-09-16T12:00:00.000Z', reason: 'review' },
      resolvedTaskBranch: {
        branch: 'DEV-63-orch-11',
        tip: 'abc123',
        commitCount: 1,
        mergeBase: 'def456',
        projectId: 'project-1',
        projectName: 'project',
        nominatingRuns: [{ record_id: 'run-record-id-11', sessionId: 'session-a' }],
        trunk: 'main',
        worktree: null,
        worktreeOwnerJob: null,
      },
    }),
  ).toMatchObject({
    job: 'implement',
    prompt: 'prompt',
    reserveId: 'run-record-id-42',
    agent: 'codex',
    routedAgent: { agent: 'codex', reason: 'thompson; best', promptBytes: 2048 },
    schemaPath: '/tmp/schema.json',
    mcp: true,
    model: 'model',
    probe: true,
    transport: 'cli',
    label: 'security lens',
    lens: 'security',
    seed: 'small',
    key: 'DEV-63',
    repo: 'project',
    base: 'main',
    avoid: ['grok'],
    distinctModels: ['other-model'],
    retryOf: 'run-record-id-7',
    cwd: '/tmp/repo',
    noFailover: true,
    noWaitCapacity: true,
    carry: true,
    resolvedTaskBranch: {
      branch: 'DEV-63-orch-11',
      tip: 'abc123',
      nominatingRuns: [{ record_id: 'run-record-id-11', sessionId: 'session-a' }],
    },
    review: 'feature/DEV-63',
    ownerSession: 'owner',
    resume,
    deliverables: ['timing'],
    timeoutMinutes: 40,
    keepTree: { until: '2026-09-16T12:00:00.000Z', reason: 'review' },
  })
})

test('a changed retry agent uses its pin unless an explicit model overrides it', () => {
  expect(retryModelForAgent('grok', 'grok-4.6', 'grok')).toBe('grok-4.6')
  expect(retryModelForAgent('grok', 'grok-4.6', 'codex')).toBe(AGENTS.codex!.model)
  expect(retryModelForAgent('grok', 'grok-4.6', 'codex', 'explicit-model')).toBe('explicit-model')
})

test('a writing run with edits names and preserves its tree instead of failing over', () => {
  const changed = {
    files: ['partial.ts'],
    diff: 'diff',
    insertions: 1,
    deletions: 0,
    since: 'base',
    trunk: 'main',
    trunkConfigured: true,
  }
  expect(writingFailoverRefusal(true, changed, '/tmp/orch-42')).toBe(
    'writing run has 1 changed file(s); preserving worktree /tmp/orch-42 so two agents never share one diff',
  )
  expect(
    writingFailoverRefusal(
      true,
      { ...changed, files: [], diff: '', insertions: 0 },
      '/tmp/orch-42',
    ),
  ).toBeNull()
  expect(writingFailoverRefusal(true, null, '/tmp/orch-42')).toContain(
    'worktree diff could not be read',
  )
})
