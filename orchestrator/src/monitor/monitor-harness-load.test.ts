import { describe, expect, test } from 'bun:test'
import type { LoadPlan } from '../canon/canon-load.ts'
import { harnessLoadCondition, observeProjectHarnessLoad } from './monitor-harness-load.ts'

const project = { name: 'sample', path: '/projects/sample' }

function plan(overrides: Partial<LoadPlan> = {}): LoadPlan {
  return {
    harness: 'claude',
    files: [
      {
        path: '/projects/sample/large.md',
        size: 90,
        kind: 'always-on',
        reason: 'fixture',
        external: false,
      },
      {
        path: '/projects/sample/small.md',
        size: 20,
        kind: 'always-on',
        reason: 'fixture',
        external: false,
      },
    ],
    total: 110,
    limit: 100,
    unit: 'chars',
    status: 'over',
    cut: [],
    skipped: [],
    ...overrides,
  }
}

describe('harness load monitor decision', () => {
  test('Claude over raises a project and harness keyed condition', () => {
    expect(harnessLoadCondition(project, plan())).toEqual({
      kind: 'harness-load-over-limit',
      subject: 'sample:claude',
      since: null,
      detail:
        'sample claude architect load measured 110 chars; limit 100 chars; largest always-on files: /projects/sample/large.md (90 chars), /projects/sample/small.md (20 chars)',
      action: 'run orch canon load --cwd /projects/sample --harness claude',
      affectedProject: 'sample',
    })
  })

  test('an ok plan does not raise', () => {
    expect(harnessLoadCondition(project, plan({ status: 'ok', total: 99 }))).toBeNull()
  })

  test('Codex truncation raises', () => {
    expect(
      harnessLoadCondition(
        project,
        plan({ harness: 'codex', status: 'truncated', total: 32768, limit: 32768, unit: 'bytes' }),
      ),
    ).toEqual(expect.objectContaining({ subject: 'sample:codex' }))
  })

  test('Grok never raises', () => {
    expect(
      harnessLoadCondition(project, plan({ harness: 'grok', limit: null, status: 'over' })),
    ).toBeNull()
  })

  test('a missing checkout is a project-scoped observation error', () => {
    expect(observeProjectHarnessLoad(project)).toEqual([
      expect.objectContaining({
        kind: 'observation-error',
        subject: 'harness-load:sample',
        affectedProject: 'sample',
      }),
    ])
  })
})
