import { expect, test } from 'bun:test'
import { jobsLosingAgentCapacity, jobsLosingCapacityFromRouting } from './agent-capacity-loss.ts'

test('an identity change refuses the only eligible agent for a job', () => {
  expect(
    jobsLosingAgentCapacity({
      identityChanged: true,
      currentEligibleJobs: ['review-lens'],
      otherEligibleAgentsByJob: { 'review-lens': [] },
    }),
  ).toEqual(['review-lens'])
})

test('an identity change allows another eligible enabled agent to carry the job', () => {
  expect(
    jobsLosingAgentCapacity({
      identityChanged: true,
      currentEligibleJobs: ['review-lens'],
      otherEligibleAgentsByJob: { 'review-lens': ['codex'] },
    }),
  ).toEqual([])
})

test('a disabled other agent does not count as eligible capacity', () => {
  expect(
    jobsLosingCapacityFromRouting(true, 'changing', {
      'review-lens': [
        { agent: 'changing', eligible: true },
        { agent: 'disabled', eligible: false },
      ],
    }),
  ).toEqual(['review-lens'])
})
