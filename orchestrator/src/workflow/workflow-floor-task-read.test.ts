import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { hubTaskReadRefusal } from './workflow-floor-evidence.ts'

test(`missing ${PLATFORM_SLUG} task refusal names the fresh tracker read`, () => {
  expect(hubTaskReadRefusal('DEV-1070', 1, 'no task DEV-1070\n', '')).toBe(
    `--task DEV-1070 was not found in the project's tracker; ${PLATFORM_SLUG} task show DEV-1070 --json --fresh attempted the registered tracker read: no task DEV-1070`,
  )
})

test.each([
  'tracker failed with token=abcdefghijklmnopqrstuvwxyz123456',
  'tracker failed with Authorization: Bearer fixture-value',
])('fresh tracker refusal withholds sensitive detail: %s', (detail) => {
  const refusal = hubTaskReadRefusal('DEV-1070', 1, detail, '')
  expect(refusal).toBe(
    `--task DEV-1070 could not be read through the project's tracker by ${PLATFORM_SLUG} task show DEV-1070 --json --fresh: detail withheld`,
  )
  expect(refusal).not.toContain(detail)
})
