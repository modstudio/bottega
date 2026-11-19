import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideRecordCacheParity, type RecordCacheParityInput } from './record-cache-parity.ts'
import { recordDoctorExitCode } from './record-doctor.ts'

const base = {
  space: 'space-a',
  activeSpace: 'space-a',
  projectSpaces: new Map([
    ['alpha', 'space-a'],
    ['outside', 'space-b'],
  ]),
  local: { byScope: [{ scope: 'canon', docs: 2 }], subjects: 3 },
  hosted: {
    byScope: [{ scope: 'canon', project: 'alpha', docs: 2 }],
    subjectsByProject: [{ project: 'alpha', subjects: 3 }],
  },
} satisfies RecordCacheParityInput

describe('record cache parity decision', () => {
  test('an exact cache passes', () => {
    expect(decideRecordCacheParity(base)).toEqual({
      name: 'record cache parity: space-a',
      status: 'pass',
      detail: 'canon: 2 local; 2 hosted — ok\nsubjects: 3 local; 3 hosted — ok',
      section: 'customer',
    })
  })

  test('a missing local group fails doctor with the pull remedy', () => {
    const decision = decideRecordCacheParity({
      ...base,
      local: { byScope: [{ scope: 'canon', docs: 1 }], subjects: 2 },
    })
    expect(decision).toMatchObject({ status: 'fail' })
    expect(decision.detail).toContain('canon: 1 local; 2 hosted — missing locally')
    expect(decision.detail).toContain('subjects: 2 local; 3 hosted — missing locally')
    expect(decision.detail).toContain(`run \`${PLATFORM_SLUG} record pull\``)
    expect(recordDoctorExitCode([decision])).toBe(1)
  })

  test('local extras are shown and pass', () => {
    const decision = decideRecordCacheParity({
      ...base,
      local: { byScope: [{ scope: 'canon', docs: 4 }], subjects: 5 },
    })
    expect(decision.status).toBe('pass')
    expect(decision.detail).toContain('canon: 4 local; 2 hosted — extra locally')
    expect(decision.detail).toContain('subjects: 5 local; 3 hosted — extra locally')
  })

  test('unowned groups are excluded and unknown scopes are listed as not mirrored', () => {
    const decision = decideRecordCacheParity({
      ...base,
      hosted: {
        ...base.hosted,
        byScope: [
          ...base.hosted.byScope,
          { scope: 'canon', project: 'outside', docs: 9 },
          { scope: 'future', project: null, docs: 4 },
        ],
      },
    })
    expect(decision.status).toBe('pass')
    expect(decision.detail).not.toContain('9')
    expect(decision.detail).toContain('future: 4 hosted — not mirrored')
  })

  test('a missing breakdown or unreachable host fails without presenting zero', () => {
    const missing = decideRecordCacheParity({ ...base, hosted: undefined })
    expect(missing).toMatchObject({ status: 'fail' })
    expect(missing.detail).toContain('could not establish')
    expect(missing.detail).not.toContain('0 hosted')

    const unreachable = decideRecordCacheParity({
      ...base,
      hosted: undefined,
      failure: 'connection refused',
    })
    expect(unreachable).toMatchObject({ status: 'fail' })
    expect(unreachable.detail).toContain('connection refused')
    expect(unreachable.detail).toContain('make the hosted record API reachable')
    expect(unreachable.detail).not.toContain('0 hosted')
  })
})
