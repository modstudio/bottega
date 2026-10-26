import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { noEligibleAgentRefusal } from './no-eligible-agent-refusal.ts'

test('an empty eligible set names both ways to restore delegation', () => {
  expect(noEligibleAgentRefusal('understand', {}, [])).toContain(
    `remedy: register and probe an agent with ${PLATFORM_SLUG} agent add and ${PLATFORM_SLUG} agent probe, or switch review work to the harness with ${PLATFORM_SLUG} machine config set --machine delegation.review harness`,
  )
})

test('existing exclusion detail remains unchanged when candidates explain their ineligibility', () => {
  expect(noEligibleAgentRefusal('implement', { writesRepo: true }, ['codex: probe required'])).toBe(
    'no eligible agent for job "implement"\ncodex: probe required',
  )
})
