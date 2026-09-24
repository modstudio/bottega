import { describe, expect, test } from 'bun:test'
import { decideCanonEvalPack, EMPTY_CANON_SHA, resolveCanonEvalProject } from './canon-eval-pack.ts'

describe('canon eval project selection', () => {
  const project = { name: 'registered', path: '/projects/registered' }

  test('a registered cwd project is selected', () => {
    const selected = resolveCanonEvalProject({
      requestedProject: null,
      cwdProject: project,
    })
    expect(selected).toEqual(project)
  })

  test('no registered project refuses and names --project', () => {
    expect(() =>
      resolveCanonEvalProject({
        requestedProject: null,
        cwdProject: null,
      }),
    ).toThrow('--project')
  })
})

describe('canon eval pack gate', () => {
  const project = { name: 'registered', path: '/projects/registered' }

  test('a registered project yields its compiled pack sha', () => {
    const selected = decideCanonEvalPack({
      project,
      pack: { project: 'registered', canonBytes: 12, sha256: 'canon-sha' },
    })
    expect(selected.canonSha).toBe('canon-sha')
  })

  test('an empty canon pack refuses and names the project', () => {
    expect(() =>
      decideCanonEvalPack({
        project,
        pack: { project: 'registered', canonBytes: 0, sha256: EMPTY_CANON_SHA },
      }),
    ).toThrow('canon eval project "registered" has no canon')
  })
})
