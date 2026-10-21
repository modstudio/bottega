import { expect, test } from 'bun:test'
import { RECORD_ACTOR_ROLE } from '../../shared/record/schema.ts'
import { asSpace } from './fixtures/postgres-rls.ts'
import * as ids from './postgres-rls-values.ts'

export function registerLandingEvidenceRlsProof(): void {
  test('cross-space landing evidence reads return nothing', () => {
    for (const [table, id] of [
      ['landing', '01990000-0000-7000-8000-00000000007b'],
      ['landing_override', '01990000-0000-7000-8000-00000000008b'],
      ['landing_review_carry', '01990000-0000-7000-8000-00000000009b'],
      ['contention', '01990000-0000-7000-8000-00000000010b'],
      ['test_flake', '01990000-0000-7000-8000-00000000011b'],
      ['branch_disposal', '01990000-0000-7000-8000-00000000012b'],
    ]) {
      const result = asSpace(
        RECORD_ACTOR_ROLE,
        'actor-password',
        ids.SPACE_A,
        `SELECT id FROM ${table} WHERE id = '${id}';`,
      )
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toBe('')
    }
  })
}
