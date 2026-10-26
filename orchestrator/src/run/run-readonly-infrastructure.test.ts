import { expect, test } from 'bun:test'
import { job, jobBoundInstruction } from '../jobs/jobs.ts'
import { readonlyInfrastructurePrompt } from './run-readonly-infrastructure.ts'

test('read-only infrastructure describes the provisioned tree without a Docker allowance', () => {
  const prompt = readonlyInfrastructurePrompt({
    readsRepo: true,
    writesRepo: false,
    readonlyCreate: true,
    readonlyNotes: 'Use the prepared fixture.',
    readOnlyBase: '/runs/tree',
    regularNotes: 'Regular notes.',
    generatedNotes: 'Generated readonly_create notes.',
    mainCheckout: '/projects/main',
  })

  expect(prompt).toContain('Use the prepared fixture.')
  expect(prompt).not.toContain('Docker is reachable')
  expect(prompt).toContain('/projects/main')
  expect(prompt).not.toContain('BOTTEGA_MAIN_CHECKOUT')
})

test('bound and infrastructure prompts use literal paths rather than environment names', () => {
  const bound = jobBoundInstruction(job('implement'), 60_000, '/runs/id/scratch')
  expect(bound).toContain('/runs/id/scratch')
  expect(bound).not.toContain('$BOTTEGA_SCRATCH')
  expect(bound).not.toContain('BOTTEGA_MAIN_CHECKOUT')
})
