import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { DelegationSettings } from '../../../shared/delegation-mode.ts'
import { harnessDelegationRefusal } from './delegation.ts'

const settings: DelegationSettings = {
  'delegation.implement': 'harness',
  'delegation.review': 'external',
}

test('a harness class refuses external dispatch with its setting and exact switch command', () => {
  expect(harnessDelegationRefusal({ needs: { writesRepo: true } }, settings)).toBe(
    `this machine runs implement work through the harness's own sub-agent (delegation.implement=harness)\n` +
      `cleared by: ${PLATFORM_SLUG} machine config set --machine delegation.implement external`,
  )
  expect(harnessDelegationRefusal({ needs: { readsRepo: true } }, settings)).toBeNull()
})
