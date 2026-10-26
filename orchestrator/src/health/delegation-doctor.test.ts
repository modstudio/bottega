import { expect, test } from 'bun:test'
import type { DelegationSettings } from '../../../shared/delegation-mode.ts'
import type { Job } from '../jobs/jobs.ts'
import { delegationDoctorLines } from './delegation-doctor.ts'

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
