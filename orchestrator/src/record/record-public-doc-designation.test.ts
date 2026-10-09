import { describe, expect, test } from 'bun:test'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import {
  type PublicDocDesignationFacts,
  publicDocDesignationRefusal,
} from './record-public-doc-designation.ts'

const complete: PublicDocDesignationFacts = {
  action: 'designate',
  userId: 'user',
  spaceId: 'space',
  projectId: 'project',
  alreadyDesignated: false,
  affectedRows: 1,
  spaceSlug: 'public',
  projectName: 'alpha',
}

describe('public document designation decision', () => {
  test('break: deleting the user guard allows an owner write without a signed-in record user', () => {
    expect(publicDocDesignationRefusal({ ...complete, userId: null })).toBe(RECORD_SIGN_IN_REMEDY)
  })

  test('break: deleting lookup refusals turns unknown spaces and projects into silent zero-row success', () => {
    expect(publicDocDesignationRefusal({ ...complete, spaceId: null })).toContain(
      'not a member of record space',
    )
    expect(publicDocDesignationRefusal({ ...complete, projectId: null })).toContain(
      'does not exist in space',
    )
  })

  test('break: treating every zero-row designate as failure rejects an idempotent designation', () => {
    expect(
      publicDocDesignationRefusal({
        ...complete,
        alreadyDesignated: true,
        affectedRows: null,
      }),
    ).toBeNull()
  })

  test('break: removing the exact-row check accepts a raced zero-row designate', () => {
    expect(publicDocDesignationRefusal({ ...complete, affectedRows: 0 })).toContain(
      'changed 0 public document designations instead of one',
    )
  })

  test('break: removing the absent guard makes clearing a missing designation report success', () => {
    expect(
      publicDocDesignationRefusal({
        ...complete,
        action: 'clear',
        alreadyDesignated: false,
        affectedRows: null,
      }),
    ).toContain('is not publicly designated')
  })
})
