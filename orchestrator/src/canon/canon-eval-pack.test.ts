import { describe, expect, test } from 'bun:test'
import { EMPTY_CANON_SHA, decideCanonEvalPack } from './canon-eval-pack.ts'

describe('canon eval pack gate', () => {
  const project = { name: 'registered', path: '/projects/registered' }

  test('a registered project yields its compiled pack sha', () => {
    const selected = decideCanonEvalPack({
      requestedProject: null,
      cwdProject: project,
      pack: { project: 'registered', canonBytes: 12, sha256: 'canon-sha' },
    })
    expect(selected.canonSha).toBe('canon-sha')
  })

  test('no registered project refuses and names --project', () => {
    expect(() =>
      decideCanonEvalPack({
        requestedProject: null,
        cwdProject: null,
      }),
    ).toThrow('--project')
  })

  test('an empty canon pack refuses and names the project', () => {
    expect(() =>
      decideCanonEvalPack({
        requestedProjectName: project.name,
        requestedProject: project,
        cwdProject: null,
        pack: { project: 'registered', canonBytes: 0, sha256: EMPTY_CANON_SHA },
      }),
    ).toThrow('canon eval project "registered" has no canon')
  })
})
