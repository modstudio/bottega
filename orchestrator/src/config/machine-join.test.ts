import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { unanchoredApprovalNotice } from './machine-join.ts'

test('unanchored approval names the terminal anchor command', () => {
  expect(unanchoredApprovalNotice('fixture')).toBe(
    `space fixture is not anchored; run \`${PLATFORM_SLUG} machine anchor --space fixture\` from your own terminal`,
  )
})
