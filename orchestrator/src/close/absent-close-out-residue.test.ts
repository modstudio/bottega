import { describe, expect, test } from 'bun:test'
import { decideAbsentCloseOutResidue } from './absent-close-out-residue.ts'

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
})
