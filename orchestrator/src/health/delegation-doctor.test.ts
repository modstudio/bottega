import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { DelegationSettings } from '../../../shared/delegation-mode.ts'
import type { Job } from '../jobs/jobs.ts'
import { configuredDelegationDoctorLines, delegationDoctorLines } from './delegation-doctor.ts'

const settings: DelegationSettings = {
  'delegation.implement': 'external',
  'delegation.review': 'harness',
}
const jobs = [
  { name: 'implement', needs: { writesRepo: true } },
  { name: 'understand', needs: { readsRepo: true } },
] as Job[]

test('doctor reports both modes and external class eligibility across its jobs', () => {
  expect(
    delegationDoctorLines(settings, jobs, (job) => [{ eligible: job === 'implement' }]),
  ).toEqual(['delegation.implement external — eligible agent yes', 'delegation.review harness'])
  expect(delegationDoctorLines(settings, jobs, () => [])).toContain(
    'delegation.implement external — eligible agent NO',
  )
})

test('doctor turns an unreadable delegation value into an actionable finding', () => {
  expect(
    configuredDelegationDoctorLines(
      () => {
        throw new Error(
          `key delegation.review must be one of external, harness; cleared by: ${PLATFORM_SLUG} machine config set --machine delegation.review external`,
        )
      },
      jobs,
      () => [],
    ),
  ).toEqual([
    `delegation settings unreadable — key delegation.review must be one of external, harness; cleared by: ${PLATFORM_SLUG} machine config set --machine delegation.review external`,
  ])
})
