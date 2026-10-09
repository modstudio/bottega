import { describe, expect, test } from 'bun:test'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import {
  type PublicDocDesignationFacts,
  publicDocDesignationRefusal,
  publicDocDesignationSignInRefusal,
} from './record-public-doc-designation.ts'

const complete: PublicDocDesignationFacts = {
  action: 'designate',
  spaceId: 'space',
  projectId: 'project',
  alreadyDesignated: false,
  affectedRows: 1,
  spaceSlug: 'public',
  projectName: 'alpha',
}

describe('public document designation decision', () => {
  test('all public document designation verbs require a signed-in record user', () => {
    expect(publicDocDesignationSignInRefusal(null)).toBe(RECORD_SIGN_IN_REMEDY)
    expect(publicDocDesignationSignInRefusal('user')).toBeNull()
  })

  test('writes refuse unknown spaces and projects', () => {
    expect(publicDocDesignationRefusal({ ...complete, spaceId: null })).toContain(
      'not a member of record space',
    )
    expect(publicDocDesignationRefusal({ ...complete, projectId: null })).toContain(
      'does not exist in space',
    )
  })

  test('designating an already designated project is idempotent', () => {
    expect(
      publicDocDesignationRefusal({
        ...complete,
        alreadyDesignated: true,
        affectedRows: null,
      }),
    ).toBeNull()
  })

  test('designate refuses unless it inserts exactly one row', () => {
    expect(publicDocDesignationRefusal({ ...complete, affectedRows: 0 })).toContain(
      'changed 0 public document designations instead of one',
    )
  })

  test('clear refuses a project that is not publicly designated', () => {
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
