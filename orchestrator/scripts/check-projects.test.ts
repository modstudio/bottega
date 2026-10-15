import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { projectChecksArgv } from './check-projects.ts'

test(`project checks use the current ${PLATFORM_SLUG} gate spelling`, () => {
  expect(projectChecksArgv('/checkout')).toEqual([
    `/checkout/bin/${PLATFORM_SLUG}`,
    'gate',
    'check',
    '--enabled',
  ])
})
