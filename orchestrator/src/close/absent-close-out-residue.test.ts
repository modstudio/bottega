import { describe, expect, test } from 'bun:test'
import {
  decideAbsentCloseOutResidue,
  releaseAbsentCloseOutResidueKinds,
} from './absent-close-out-residue.ts'

describe('absent close-out residue decision', () => {
  test('releases both residues only for a non-dry absent project run', () => {
    expect(
      decideAbsentCloseOutResidue({ outcome: 'absent', dryRun: false, project: 'project-a' }),
    ).toEqual(['ref-guard', 'retained-ref'])
    expect(
      decideAbsentCloseOutResidue({ outcome: 'absent', dryRun: true, project: 'project-a' }),
    ).toEqual([])
    expect(
      decideAbsentCloseOutResidue({ outcome: 'released', dryRun: false, project: 'project-a' }),
    ).toEqual([])
  })

  test('appends each reclaim failure and continues releasing later residue', () => {
    expect(
      releaseAbsentCloseOutResidueKinds({
        detail: 'conversation absent',
        kinds: ['ref-guard', 'retained-ref'],
        subject: 'project-a:42',
        reclaim: (kind) => {
          if (kind === 'ref-guard') throw new Error('not a git repository')
          return { ok: true, action: 'released retained ref' }
        },
      }),
    ).toBe(
      'conversation absent; ref-guard not released: not a git repository; released retained ref',
    )
  })

  test('tells reclaim that already-absent residue satisfies absent-tree close-out', () => {
    const options: unknown[] = []
    releaseAbsentCloseOutResidueKinds({
      detail: 'conversation absent',
      kinds: ['ref-guard', 'retained-ref'],
      subject: 'project-a:42',
      reclaim: (_kind, _subject, reclaimOptions) => {
        options.push(reclaimOptions)
        return { ok: true, action: 'already absent' }
      },
    })
    expect(options).toEqual([{ absentSatisfies: true }, { absentSatisfies: true }])
  })
})
